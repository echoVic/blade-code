import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeLoopGenerator } from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../../src/agent/types.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
  StreamToolCall,
} from '../../../../src/services/ChatServiceInterface.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../../src/tools/types/index.js';

class ExactlyOnceStreamingChatService implements IChatService {
  readonly visibleTools: string[][] = [];
  private turn = 0;

  async chat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal
  ): Promise<ChatResponse> {
    throw new Error('Streaming policy test must not use non-streaming chat');
  }

  async *streamChat(
    _messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.visibleTools.push((tools ?? []).map((tool) => tool.name));
    this.turn += 1;
    if (this.turn === 1) {
      const toolCalls: StreamToolCall[] = [
        {
          index: 0,
          id: 'stream-task-one',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"first"}' },
        },
        {
          index: 1,
          id: 'stream-task-two',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"second"}' },
        },
      ];
      yield { toolCalls, finishReason: 'tool_calls' };
      return;
    }

    yield { content: 'Delegation complete.', finishReason: 'stop' };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

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

describe('executeLoopGenerator streaming tool policy', () => {
  it('executes only one Task when the same stream requests two', async () => {
    const taskExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'Subagent completed the repair.',
    }));
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Task',
        displayName: 'Task',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: false,
        description: { short: 'Delegate work' },
        schema: z.unknown(),
        execute: taskExecution,
      })
    );
    const chatService = new ExactlyOnceStreamingChatService();
    const toolExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const dependencies: LoopDependencies = {
      chatService,
      toolExecutor,
      executionEngine: undefined,
      config: DEFAULT_CONFIG,
      runtimeOptions: {
        appendSystemPrompt: 'Call Task exactly once, then return a final answer.',
      },
      currentModelMaxContextTokens: 64_000,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      userId: 'stream-policy-user',
      sessionId: 'stream-policy-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Delegate this repair with the Task tool.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(taskExecution).toHaveBeenCalledTimes(1);
    expect(chatService.visibleTools).toEqual([['Task'], []]);
    expect(
      events
        .filter((event) => event.kind === 'tool_result')
        .map((event) => ({
          id: 'function' in event.toolCall ? event.toolCall.id : '',
          success: event.result.success,
          errorType: event.result.error?.type,
        }))
    ).toEqual([
      { id: 'stream-task-one', success: true, errorType: undefined },
      {
        id: 'stream-task-two',
        success: false,
        errorType: 'validation_error',
      },
    ]);
  });
});
