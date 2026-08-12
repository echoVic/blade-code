import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BackgroundAgentManager } from '../../src/agent/subagents/BackgroundAgentManager.js';
import { PermissionMode } from '../../src/config/types.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { getState } from '../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
} from '../integration/real-api/testConfig.js';

const [workspace, storageRoot, parentSessionId, agentId, qualificationId] =
  process.argv.slice(2);
if (!workspace || !storageRoot || !parentSessionId || !agentId || !qualificationId) {
  process.exit(2);
}

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

await runWithCwdOverride(workspace, async () => {
  const command =
    `printf '%s' "$$" > child-foreground.pid; ` +
    `trap '' TERM; sleep 5; printf late > forbidden-child-late-effect.txt; ` +
    `sleep 300`;
  const manager = BackgroundAgentManager.getInstance();
  const startedId = manager.startBackgroundAgent({
    config: {
      name: 'crash-shell',
      description: 'Run one foreground shell across a hard restart',
      systemPrompt:
        'Follow the requested Bash arguments exactly. Do not call another tool.',
      tools: ['Bash'],
      model: runtimeConfig.currentModelId,
      permissionMode: PermissionMode.YOLO,
      maxTurns: 2,
    },
    description: 'Start child foreground shell',
    prompt:
      'Call Bash exactly once using these exact arguments: ' +
      `${JSON.stringify({ command, run_in_background: false })}. ` +
      'Do not alter either argument.',
    parentSessionId,
    parentProjectPath: workspace,
    permissionMode: PermissionMode.YOLO,
    agentId,
    workspaceRoot: workspace,
  });

  const leaseRoot = path.join(
    getProjectStoragePath(workspace),
    '.foreground-processes'
  );
  const deadline = Date.now() + 120_000;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const commandPid = Number.parseInt(
        await readFile(path.join(workspace, 'child-foreground.pid'), 'utf8'),
        10
      );
      const leaseNames = await readdir(leaseRoot, { recursive: true });
      const leaseName = leaseNames.find((name) => name.endsWith('.json'));
      if (Number.isSafeInteger(commandPid) && commandPid > 1 && leaseName) {
        process.stdout.write(`${JSON.stringify({ commandPid, leaseName })}\n`);
        announced = true;
        break;
      }
    } catch {
      // The real model or foreground admission gate is still running.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!announced) {
    throw new Error('Subagent foreground command did not cross durable admission');
  }
  await manager.waitForCompletion(startedId, 0);
});
