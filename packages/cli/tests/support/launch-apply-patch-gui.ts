import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-apply-patch-gui.ts',
  defaultPort: 4321,
  configure: () => ({ config: {} }),
  setup: async ({ workspace }) => {
    await Promise.all([
      writeFile(path.join(workspace, 'first.ts'), 'export const first = false;\n'),
      writeFile(path.join(workspace, 'second.ts'), 'export const second = false;\n'),
    ]);
  },
  afterCommit: async ({ canonicalWorkspace }) => ({
    first: path.join(canonicalWorkspace, 'first.ts'),
    second: path.join(canonicalWorkspace, 'second.ts'),
    added: path.join(canonicalWorkspace, 'added.ts'),
  }),
});
