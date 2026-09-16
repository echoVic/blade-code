import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-auto-verify-gui.ts',
  defaultPort: 4319,
  configure: () => ({ config: { permissionMode: 'yolo' } }),
  setup: async ({ root, workspace }) => {
    const marker = path.join(root, 'auto-verify-marker');
    const afterTarget = path.join(workspace, 'after-trust.ts');
    await Promise.all([
      writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify(
          {
            name: 'blade-auto-verify-gui',
            version: '1.0.0',
            private: true,
            scripts: { 'type-check': 'node type-check.cjs' },
          },
          null,
          2
        )}\n`
      ),
      writeFile(path.join(workspace, 'tsconfig.json'), '{}\n'),
      writeFile(
        path.join(workspace, 'type-check.cjs'),
        [
          `require('node:fs').writeFileSync(${JSON.stringify(
            marker
          )}, process.env.BLADE_SESSION_ID || 'missing');`,
          `process.stderr.write(${JSON.stringify(
            `${afterTarget}(1,1): error TS9001: GUI_AUTO_VERIFY_SIGNAL\n`
          )});`,
          'process.exitCode = 1;',
        ].join('\n')
      ),
    ]);
  },
  afterCommit: async ({ root, workspace }) => ({
    marker: path.join(root, 'auto-verify-marker'),
    beforeTarget: path.join(workspace, 'before-trust.ts'),
    afterTarget: path.join(workspace, 'after-trust.ts'),
  }),
});
