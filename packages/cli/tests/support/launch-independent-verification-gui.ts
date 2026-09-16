import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-independent-verification-gui.ts',
  defaultPort: 4326,
  environment: { BLADE_TELEMETRY_DISABLED: '1' },
  configure: () => ({
    config: { permissionMode: 'yolo' },
    metadata: {
      prompt: [
        'Read src/alpha.js, src/beta.js, and src/gamma.js.',
        'Then call ApplyPatch exactly once to change each exported value from',
        'false to true. Do not modify package.json or the test.',
        'After ApplyPatch succeeds, return exactly WEB_INDEPENDENT_VERIFY_OK.',
      ].join(' '),
    },
  }),
  setup: async ({ workspace }) => {
    await Promise.all([
      mkdir(path.join(workspace, 'src'), { recursive: true }),
      mkdir(path.join(workspace, 'test'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify(
          {
            name: 'blade-independent-verification-gui',
            private: true,
            type: 'module',
            scripts: { test: 'node --test' },
          },
          null,
          2
        )}\n`
      ),
      ...['alpha', 'beta', 'gamma'].map((name) =>
        writeFile(
          path.join(workspace, `src/${name}.js`),
          `export const ${name} = false;\n`
        )
      ),
      writeFile(
        path.join(workspace, 'test/values.test.js'),
        [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { alpha } from '../src/alpha.js';",
          "import { beta } from '../src/beta.js';",
          "import { gamma } from '../src/gamma.js';",
          '',
          "test('all values are enabled', () => {",
          '  assert.equal(alpha, true);',
          '  assert.equal(beta, true);',
          '  assert.equal(gamma, true);',
          '});',
          '',
        ].join('\n')
      ),
    ]);
  },
});
