import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { executeLoopGenerator } from '../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../src/agent/types.js';
import { PermissionMode } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { HookTrustService } from '../../../src/hooks/HookTrustService.js';
import { type HookConfig, HookType } from '../../../src/hooks/types/HookTypes.js';
import { Type } from '../../../src/schema/index.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';
import { getState } from '../../../src/store/vanilla.js';
import { createTool } from '../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../src/tools/types/index.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

vi.unmock('node:child_process');

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;

async function drain(
  generator: AsyncGenerator<LoopEvent, LoopResult, void>
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let current = await generator.next();
  while (!current.done) {
    events.push(current.value);
    current = await generator.next();
  }
  return { events, result: current.value };
}

function markerCommand(marker: string): string {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'trusted')`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describeReal('hook trust trajectory (real API)', () => {
  it('blocks an untrusted hook and runs it only after exact digest approval', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-hook-trust-'));
    const workspace = path.join(root, 'workspace');
    const marker = path.join(root, 'hook-marker');
    await mkdir(workspace, { recursive: true });

    const originalConfig = getState().config.config;
    const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    HookManager.resetInstance();
    HookTrustService.resetInstance();

    const config = buildRealApiRuntimeConfig(gpt);
    getState().config.actions.setConfig(config);
    const selected = config.models[0]!;
    const resolved = resolveModelConfig(selected, config, 'off');
    const toolName = 'hook_trust_probe';
    let toolExecutions = 0;
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: toolName,
        displayName: 'Hook trust probe',
        kind: ToolKind.Execute,
        isConcurrencySafe: false,
        schema: Type.Object({}),
        description: {
          short: 'Returns an external qualification value unavailable in the prompt.',
          important: [`Call ${toolName} with {} exactly once before answering.`],
        },
        async execute() {
          toolExecutions += 1;
          return {
            success: true,
            llmContent: `external-value-${toolExecutions}`,
          };
        },
      }) as never
    );
    registry.deferredToolManager.markLoaded(toolName);

    const hookConfig: HookConfig = {
      enabled: true,
      PreToolUse: [
        {
          matcher: { tools: toolName },
          hooks: [
            {
              type: HookType.Command,
              command: markerCommand(marker),
            },
          ],
        },
      ],
    };
    let manager = HookManager.getInstance();
    manager.loadConfig(hookConfig, workspace);

    const qualificationPrompt =
      `You must call ${toolName} with {} exactly once. ` +
      'The external value is unavailable until the tool returns. ' +
      'After the tool succeeds, report its returned value.';
    const dependencies: LoopDependencies = {
      chatService: new PiAIChatService({
        ...resolved.chat,
        temperature: 0,
        maxOutputTokens: 192,
        maxRetries: 0,
      }),
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: undefined,
      config,
      runtimeOptions: {
        maxTurns: 3,
        appendSystemPrompt: qualificationPrompt,
      },
      currentModelMaxContextTokens: resolved.model.contextWindow,
      applySkillToolRestrictions: (tools) => tools,
    };

    const run = (sessionId: string) => {
      const context: ChatContext = {
        messages: [],
        sessionId,
        userId: 'qualification',
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      return drain(
        executeLoopGenerator(
          dependencies,
          'Fetch and report the external qualification value.',
          context,
          { stream: true },
          qualificationPrompt
        )
      );
    };

    try {
      const untrusted = await run('real-hook-untrusted');
      expect(untrusted.result.success).toBe(true);
      expect(untrusted.events.some((event) => event.kind === 'tool_result')).toBe(true);
      expect(toolExecutions).toBe(1);
      await expect(access(marker)).rejects.toThrow();
      expect((await manager.getTrustStatus(workspace)).state).toBe('untrusted');

      await manager.trustProject(workspace);
      HookManager.resetInstance();
      manager = HookManager.getInstance();
      manager.loadConfig(hookConfig, workspace);
      expect((await manager.getTrustStatus(workspace)).state).toBe('trusted');
      const trusted = await run('real-hook-trusted');
      expect(trusted.result.success).toBe(true);
      expect(toolExecutions).toBe(2);
      await expect(access(marker)).resolves.toBeUndefined();
      expect((await manager.getTrustStatus(workspace)).state).toBe('trusted');
      assertNoSecrets({ untrusted, trusted }, [gpt.apiKey]);
    } finally {
      HookManager.resetInstance();
      HookTrustService.resetInstance();
      if (previousStorageRoot === undefined) {
        delete process.env.BLADE_STORAGE_ROOT;
      } else {
        process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
      }
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
