import { runHeadless } from '../../src/commands/headless.js';
import { PermissionMode } from '../../src/config/types.js';
import { getState } from '../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
} from '../integration/real-api/testConfig.js';

const [workspace, storageRoot, sessionId, qualificationId] = process.argv.slice(2);
if (!workspace || !storageRoot || !sessionId || !qualificationId) process.exit(2);

const modelConfig = expandDeepSeekModelMatrix(
  getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
).find((config) => config.qualificationId === qualificationId);
if (!modelConfig) throw new Error('Requested real API model is unavailable');

process.env.BLADE_STORAGE_ROOT = storageRoot;
const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
getState().config.actions.setConfig({
  ...runtimeConfig,
  permissionMode: PermissionMode.YOLO,
});

const command =
  `printf '%s' "$$" > foreground-root.pid; ` +
  `trap '' TERM; sleep 5; printf late > forbidden-late-effect.txt; sleep 300`;
const exitCode = await runWithCwdOverride(workspace, () =>
  runHeadless({
    headless: true,
    outputFormat: 'jsonl',
    maxTurns: 4,
    model: runtimeConfig.currentModelId,
    sessionId,
    allowedTools: ['Bash'],
    appendSystemPrompt:
      'Call Bash exactly once using these exact arguments: ' +
      `${JSON.stringify({ command, run_in_background: false })}. ` +
      'Do not call any other tool and do not alter either argument.',
    message: 'Run the requested foreground command now.',
  })
);
process.exit(exitCode);
