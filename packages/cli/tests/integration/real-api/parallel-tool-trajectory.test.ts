import { describe, expect, it } from 'vitest';
import { executeLoopGenerator } from '../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../src/agent/types.js';
import { PermissionMode } from '../../../src/config/types.js';
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

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeParallel = gpt ? describe.sequential : describe.skip;

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

describeParallel('parallel tool trajectory (real API)', () => {
  it('executes two tools from one production stream concurrently', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const originalConfig = getState().config.config;
    const config = buildRealApiRuntimeConfig(gpt);
    getState().config.actions.setConfig(config);
    const selected = config.models[0]!;
    const resolved = resolveModelConfig(selected, config, 'off');

    const started = new Set<string>();
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const waitForBoth = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Parallel probe did not overlap')),
          8_000
        );
        void bothStarted.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    let overlapProven = false;
    const executeProbe = async (name: string) => {
      started.add(name);
      if (started.size === 2) {
        overlapProven = true;
        releaseBoth();
      }
      await waitForBoth();
      return {
        success: true,
        llmContent: `${name} completed`,
      };
    };

    const registry = new ToolRegistry();
    for (const name of ['parallel_probe_a', 'parallel_probe_b']) {
      registry.register(
        createTool({
          name,
          displayName: name,
          kind: ToolKind.Execute,
          isConcurrencySafe: false,
          parallelism: 'shared',
          schema: Type.Object({}),
          description: {
            short: `${name} returns one external value that is not available in the prompt`,
            important: [
              `Call ${name} together with the other parallel_probe tool in the same response.`,
            ],
          },
          async execute() {
            return executeProbe(name);
          },
        }) as never
      );
      registry.deferredToolManager.markLoaded(name);
    }
    expect(
      registry
        .getFunctionDeclarationsByMode(PermissionMode.YOLO)
        .map((tool) => tool.name)
    ).toEqual(['parallel_probe_a', 'parallel_probe_b']);

    const chatService = new PiAIChatService({
      ...resolved.chat,
      temperature: 0,
      maxOutputTokens: 256,
      maxRetries: 0,
    });
    const qualificationPrompt =
      'The two external values are not in this prompt. You must call ' +
      'parallel_probe_a and parallel_probe_b together in one assistant ' +
      'response with {} arguments. Never call only one probe or invent a ' +
      'value. After both succeed, report both returned values.';
    const dependencies: LoopDependencies = {
      chatService,
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: undefined,
      config,
      runtimeOptions: {
        maxTurns: 4,
        appendSystemPrompt: qualificationPrompt,
      },
      currentModelMaxContextTokens: resolved.model.contextWindow,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      sessionId: 'real-parallel-tool-trajectory',
      userId: 'qualification',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    try {
      const { events, result } = await drain(
        executeLoopGenerator(
          dependencies,
          'Fetch external value A and external value B with the two tools. ' +
            'Call both tools in the same response, then report both values.',
          context,
          { stream: true },
          qualificationPrompt
        )
      );
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result'
      );
      const toolStarts = events
        .filter(
          (event): event is Extract<LoopEvent, { kind: 'tool_start' }> =>
            event.kind === 'tool_start'
        )
        .map((event) =>
          'function' in event.toolCall ? event.toolCall.function.name : ''
        );

      expect(result.success).toBe(true);
      expect(started).toEqual(new Set(['parallel_probe_a', 'parallel_probe_b']));
      expect(new Set(toolStarts)).toEqual(
        new Set(['parallel_probe_a', 'parallel_probe_b'])
      );
      expect(overlapProven).toBe(true);
      expect(
        toolResults.map((event) =>
          event.kind === 'tool_result' && 'function' in event.toolCall
            ? event.toolCall.function.name
            : ''
        )
      ).toEqual(toolStarts);
      expect(toolResults.every((event) => event.result.success)).toBe(true);
      assertNoSecrets({ events, result }, [gpt.apiKey]);
    } finally {
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
    }
  }, 90_000);
});
