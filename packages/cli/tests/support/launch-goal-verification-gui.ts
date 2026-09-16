import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-goal-verification-gui.ts',
  defaultPort: 4343,
  environment: { BLADE_TELEMETRY_DISABLED: '1' },
  configure: ({ model }) => ({
    config: {
      permissionMode: 'yolo',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    metadata: {
      model: model.model,
      prompt:
        '/goal Create goal-gui.txt with the exact content GOAL_GUI_VERIFIED. ' +
        'Read it back, run npm test, then call UpdateGoal complete.',
    },
  }),
  setup: async ({ workspace }) => {
    await Promise.all([
      writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify(
          {
            name: 'blade-goal-verification-gui',
            private: true,
            scripts: { test: 'node --test goal.test.cjs' },
          },
          null,
          2
        )}\n`
      ),
      writeFile(
        path.join(workspace, 'goal.test.cjs'),
        [
          "const assert = require('node:assert/strict');",
          "const fs = require('node:fs');",
          "const test = require('node:test');",
          '',
          "test('verified goal output', () => {",
          "  assert.equal(fs.readFileSync('goal-gui.txt', 'utf8').trim(), 'GOAL_GUI_VERIFIED');",
          '});',
          '',
        ].join('\n')
      ),
    ]);
  },
});
