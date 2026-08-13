import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutionEngine } from '../../../src/agent/ExecutionEngine.js';
import { executeLoopGenerator } from '../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../src/agent/types.js';
import { PermissionMode } from '../../../src/config/types.js';
import { ContextManager } from '../../../src/context/ContextManager.js';
import { Type } from '../../../src/schema/index.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';
import { getState } from '../../../src/store/vanilla.js';
import { createTool } from '../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../src/tools/types/index.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const deepseek = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    ).find((config) => config.model.includes('flash'))
  : undefined;
const describeReal = deepseek ? describe.sequential : describe.skip;

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

describeReal('action stationarity recovery trajectory (real API)', () => {
  it('nudges a real model out of repeated tool polling without leaking controls', async () => {
    if (!deepseek) throw new Error('DeepSeek Flash qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-stationarity-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(storageRoot, { recursive: true }),
    ]);

    const originalConfig = getState().config.config;
    const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const config = buildRealApiRuntimeConfig(deepseek);
    getState().config.actions.setConfig(config);
    const resolved = resolveModelConfig(config.models[0]!, config, 'off');
    const sessionId = `stationarity-${Date.now()}`;
    let executions = 0;

    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'stationary_probe',
        displayName: 'Stationary probe',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: true,
        schema: Type.Object({
          key: Type.Literal('same'),
        }),
        description: {
          short: 'Returns a deliberately unchanged external qualification state.',
        },
        async execute() {
          executions++;
          return {
            success: true,
            llmContent: {
              state: 'UNCHANGED_EXTERNAL_STATE',
            },
          };
        },
      }) as never
    );
    registry.deferredToolManager.markLoaded('stationary_probe');

    const chatService = new PiAIChatService({
      ...resolved.chat,
      temperature: 0,
      maxOutputTokens: 256,
      maxRetries: 0,
    });
    const contextManager = new ContextManager({ projectPath: workspace });
    await contextManager.initialize();
    const qualificationPrompt =
      'This is a host recovery qualification. Call stationary_probe with ' +
      '{"key":"same"} exactly once per assistant turn. After every unchanged ' +
      'result, call it again in the next turn. Do not stop voluntarily. Only when ' +
      'a system reminder explicitly says the action is repeating without progress, ' +
      'stop calling tools and reply exactly STATIONARITY_RECOVERED.';
    const dependencies: LoopDependencies = {
      chatService,
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: new ExecutionEngine(chatService, contextManager, workspace),
      config,
      runtimeOptions: {
        maxTurns: 12,
        appendSystemPrompt: qualificationPrompt,
      },
      currentModelMaxContextTokens: resolved.model.contextWindow,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      sessionId,
      userId: 'qualification',
      workspaceRoot: workspace,
      permissionMode: PermissionMode.YOLO,
    };

    try {
      const run = await drain(
        executeLoopGenerator(
          dependencies,
          qualificationPrompt,
          context,
          { stream: true },
          qualificationPrompt
        )
      );
      const stationarity = run.events.filter(
        (event): event is Extract<LoopEvent, { kind: 'action_stationarity' }> =>
          event.kind === 'action_stationarity'
      );

      expect(run.result).toMatchObject({
        success: true,
        finalMessage: 'STATIONARITY_RECOVERED',
      });
      expect(executions).toBe(8);
      expect(stationarity.map((event) => event.phase)).toEqual([
        'detected',
        'recovered',
      ]);
      expect(stationarity[0]).toMatchObject({
        toolName: 'stationary_probe',
        runLength: 8,
      });

      const durable = await SessionService.loadSession(sessionId, workspace);
      expect(durable).toContainEqual(
        expect.objectContaining({
          role: 'user',
          metadata: expect.objectContaining({ clientVisible: false }),
          content: expect.stringContaining('without observable progress'),
        })
      );
      expect(
        SessionService.toUISafeMessages(durable).some((message) =>
          message.content.includes('without observable progress')
        )
      ).toBe(false);
      assertNoSecrets({ run, durable }, [deepseek.apiKey]);
    } finally {
      if (originalStorageRoot === undefined) {
        delete process.env.BLADE_STORAGE_ROOT;
      } else {
        process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
      }
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
