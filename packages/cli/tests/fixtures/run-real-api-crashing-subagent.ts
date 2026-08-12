import { BackgroundAgentManager } from '../../src/agent/subagents/BackgroundAgentManager.js';
import { PermissionMode } from '../../src/config/types.js';
import { getState } from '../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
} from '../integration/real-api/testConfig.js';

const [
  workspace,
  storageRoot,
  parentSessionId,
  agentId,
  qualificationId,
  token,
  proxyBaseUrl,
] = process.argv.slice(2);
if (
  !workspace ||
  !storageRoot ||
  !parentSessionId ||
  !agentId ||
  !qualificationId ||
  !token ||
  !proxyBaseUrl
) {
  process.exit(2);
}

const modelConfig = expandDeepSeekModelMatrix(
  getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
).find((config) => config.qualificationId === qualificationId);
if (!modelConfig) throw new Error('Requested real API model is unavailable');

process.env.BLADE_STORAGE_ROOT = storageRoot;
const runtimeConfig = buildRealApiRuntimeConfig({
  ...modelConfig,
  baseURL: proxyBaseUrl,
});
getState().config.actions.setConfig({
  ...runtimeConfig,
  permissionMode: PermissionMode.YOLO,
});

await runWithCwdOverride(workspace, async () => {
  let announced = false;
  const manager = BackgroundAgentManager.getInstance();
  const startedId = manager.startBackgroundAgent({
    config: {
      name: 'crash-memory',
      description: 'Remember context across a hard restart',
      systemPrompt:
        'Answer directly without tools. Preserve earlier user context for follow-ups.',
      tools: [],
      model: runtimeConfig.currentModelId,
      permissionMode: PermissionMode.YOLO,
      maxTurns: 2,
    },
    description: 'Remember crash recovery token',
    prompt:
      `For this review, remember the private module codename ${token}. ` +
      'Reply with a short acknowledgement.',
    parentSessionId,
    parentProjectPath: workspace,
    permissionMode: PermissionMode.YOLO,
    agentId,
    workspaceRoot: workspace,
    onEvent: (event) => {
      if (!announced && event.kind === 'content_delta') {
        announced = true;
        process.stdout.write('SUBAGENT_STREAM_STARTED\n');
      }
    },
  });
  await manager.waitForCompletion(startedId, 0);
});
