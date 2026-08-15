import path from 'node:path';
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const rootPidFile = path.join(workspace, 'foreground-root.pid');
const forbiddenEffectFile = path.join(workspace, 'forbidden-late-effect.txt');
const childFixture = path.join(import.meta.dirname, 'run-real-api-foreground-child.ts');
const releaseMarker = path.join(workspace, 'foreground-gate.release');
const command =
  `${shellQuote(process.execPath)} ${shellQuote(childFixture)} ` +
  `${shellQuote(rootPidFile)} ${shellQuote(forbiddenEffectFile)} </dev/null & ` +
  `while [ ! -f ${shellQuote(releaseMarker)} ]; do sleep 0.01; done`;
const invocation =
  'Call Bash exactly once using these exact arguments: ' +
  `${JSON.stringify({ command, run_in_background: false })}. ` +
  'Do not call any other tool, do not alter either argument, and do not answer ' +
  'with plain text before the Bash call starts.';
const exitCode = await runWithCwdOverride(workspace, () =>
  runHeadless({
    headless: true,
    outputFormat: 'jsonl',
    maxTurns: 4,
    model: runtimeConfig.currentModelId,
    sessionId,
    allowedTools: ['Bash'],
    appendSystemPrompt: invocation,
    message: invocation,
  })
);
process.exit(exitCode);
