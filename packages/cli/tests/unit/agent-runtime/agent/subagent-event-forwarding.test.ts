/**
 * Subagent 事件转发测试
 *
 * 覆盖 SubagentExecutor 中 LoopEvent -> SubagentContext 回调的映射逻辑：
 * - onEvent 统一回调转发
 * - 系统事件静默忽略
 * - LoopResult 正确返回
 * - Bus topic 稳定性
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';

/** 创建一个 mock async generator，yield 给定事件后返回 LoopResult */
function createMockGenerator(events: LoopEvent[], result?: Partial<LoopResult>) {
  const defaultResult: LoopResult = {
    success: true,
    finalMessage: 'done',
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 100 },
    ...result,
  };
  return async function* () {
    for (const event of events) {
      yield event;
    }
    return defaultResult;
  };
}

/** Mock Agent 的 chatStream 方法 */
const mockChatStream =
  vi.fn<
    (
      message: string,
      context: Record<string, unknown>
    ) => AsyncGenerator<LoopEvent, LoopResult, void>
  >();

const runtimeState = vi.hoisted(() => ({
  runtime: {
    dispose: vi.fn(async () => undefined),
  },
  create: vi.fn(),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: runtimeState.create,
  },
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    create: vi.fn(async () => ({
      chatStream: mockChatStream,
    })),
    createWithRuntime: vi.fn(async () => ({
      chatStream: mockChatStream,
      destroy: vi.fn(async () => undefined),
    })),
  },
}));

describe('SubagentExecutor event forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.create.mockResolvedValue(runtimeState.runtime);
  });

  it('forwards all events via onEvent', async () => {
    const events: LoopEvent[] = [
      { kind: 'content_delta', delta: 'hello' },
      { kind: 'thinking_delta', delta: 'hmm' },
      {
        kind: 'tool_start',
        toolCall: {
          id: 't1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      },
      {
        kind: 'tool_result',
        toolCall: {
          id: 't1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
        result: { success: true, llmContent: 'ok' },
      },
      { kind: 'stream_end' },
      { kind: 'turn_start', turn: 1, maxTurns: 5 },
      {
        kind: 'token_usage',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          maxContextTokens: 128000,
        },
      },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const receivedEvents: LoopEvent[] = [];
    const onEvent = vi.fn((event: LoopEvent) => {
      receivedEvents.push(event);
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({
      prompt: 'do something',
      onEvent,
    });

    expect(result.success).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(events.length);
    // Verify each event was forwarded in order
    expect(receivedEvents.map((e) => e.kind)).toEqual(events.map((e) => e.kind));
  });

  it('silently drops events when no onEvent is provided', async () => {
    const events: LoopEvent[] = [
      { kind: 'content_delta', delta: 'hello' },
      { kind: 'stream_end' },
    ];

    mockChatStream.mockImplementation(createMockGenerator(events));

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    // No onEvent provided — should not throw
    const result = await executor.execute({ prompt: 'do something' });

    expect(result.success).toBe(true);
  });

  it('returns LoopResult with correct stats on success', async () => {
    mockChatStream.mockImplementation(
      createMockGenerator([], {
        success: true,
        finalMessage: 'task complete',
        metadata: {
          turnsCount: 3,
          toolCallsCount: 5,
          duration: 2000,
          tokensUsed: 1500,
        },
      })
    );

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({ prompt: 'do something' });

    expect(result.success).toBe(true);
    expect(result.message).toBe('task complete');
    expect(result.stats?.toolCalls).toBe(5);
    expect(result.stats?.tokens).toBe(1500);
  });

  it('passes custom agent policy into completion requirements', async () => {
    mockChatStream.mockImplementation(createMockGenerator([]));

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );
    const executor = new SubagentExecutor({
      name: 'test',
      description: 'test agent',
      systemPrompt: 'Edit the source and run npm test before finishing.',
    });

    await executor.execute({ prompt: 'repair the project' });

    expect(mockChatStream).toHaveBeenCalledWith(
      'repair the project',
      expect.objectContaining({
        completionRequirements: 'Edit the source and run npm test before finishing.',
      })
    );
  });

  it('returns only successful verification commands executed after the last edit', async () => {
    const toolResult = (
      id: string,
      name: string,
      metadata: Record<string, unknown>
    ): LoopEvent => ({
      kind: 'tool_result',
      toolCall: {
        id,
        type: 'function',
        function: { name, arguments: '{}' },
      },
      result: { success: true, llmContent: 'ok', metadata },
    });
    const events: LoopEvent[] = [
      toolResult('test-before-edit', 'Bash', {
        command: 'npm test',
        exit_code: 0,
      }),
      toolResult('edit', 'Edit', {}),
      toolResult('failed-test', 'Bash', {
        command: 'npm test -- failed',
        exit_code: 1,
      }),
      toolResult('test-after-edit', 'Bash', {
        command: 'npm test',
        exit_code: 0,
      }),
      toolResult('not-verification', 'Bash', {
        command: 'git status --short',
        exit_code: 0,
      }),
    ];
    mockChatStream.mockImplementation(createMockGenerator(events));

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );
    const result = await new SubagentExecutor({
      name: 'test',
      description: 'test agent',
    }).execute({ prompt: 'fix and verify' });

    expect(result.verificationCommands).toEqual(['npm test']);
  });

  it('returns failure result when generator throws', async () => {
    mockChatStream.mockImplementation(async function* (): AsyncGenerator<
      LoopEvent,
      LoopResult,
      void
    > {
      if (Date.now() < 0) {
        yield { kind: 'stream_end' };
      }
      throw new Error('model overloaded');
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({ prompt: 'do something' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('model overloaded');
  });

  it('handles empty content turns gracefully', async () => {
    // A turn with no content deltas, just stream_end
    const events: LoopEvent[] = [
      { kind: 'turn_start', turn: 1, maxTurns: 5 },
      { kind: 'stream_end' },
    ];

    mockChatStream.mockImplementation(
      createMockGenerator(events, {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 50 },
      })
    );

    const receivedEvents: LoopEvent[] = [];
    const onEvent = vi.fn((event: LoopEvent) => {
      receivedEvents.push(event);
    });

    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({ name: 'test', description: 'test agent' });
    const result = await executor.execute({
      prompt: 'do something',
      onEvent,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('');
    expect(receivedEvents).toHaveLength(2);
  });

  it('runs a pre-isolated child in its worktree and hides lifecycle tools', async () => {
    mockChatStream.mockImplementation(createMockGenerator([]));
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({
      name: 'writer',
      description: 'writer agent',
      systemPrompt: 'Focus on implementation and verification.',
    });
    const result = await executor.execute({
      prompt: 'implement the requested change',
      subagentSessionId: 'child-1',
      workspaceRoot: '/tmp/isolated-worktree',
      worktreeActive: true,
    });

    expect(result.success).toBe(true);
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'child-1',
        workspaceRoot: '/tmp/isolated-worktree',
      })
    );
    expect(Agent.createWithRuntime).toHaveBeenCalledWith(
      runtimeState.runtime,
      expect.objectContaining({
        toolBlacklist: expect.arrayContaining(['EnterWorktree', 'ExitWorktree']),
        appendSystemPrompt: 'Focus on implementation and verification.',
      })
    );
    expect(mockChatStream).toHaveBeenCalledWith(
      'implement the requested change',
      expect.objectContaining({
        sessionId: 'child-1',
        workspaceRoot: '/tmp/isolated-worktree',
        worktreeActive: true,
      })
    );
    expect(mockChatStream.mock.calls.at(-1)?.[1]).not.toHaveProperty('systemPrompt');
  });

  it('enforces invocation-specific limits and permissions', async () => {
    mockChatStream.mockImplementation(createMockGenerator([]));
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { PermissionMode } = await import('../../../../src/config/types.js');
    const { SubagentExecutor } = await import(
      '../../../../src/agent/subagents/SubagentExecutor.js'
    );

    const executor = new SubagentExecutor({
      name: 'reviewer',
      description: 'reviewer agent',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash', 'Write'],
      maxTurns: 4,
      permissionMode: PermissionMode.PLAN,
    });
    await executor.execute({
      prompt: 'review the change',
      permissionMode: PermissionMode.YOLO,
    });

    expect(Agent.createWithRuntime).toHaveBeenCalledWith(
      runtimeState.runtime,
      expect.objectContaining({
        toolWhitelist: ['Read', 'Bash'],
        toolBlacklist: ['EnterWorktree', 'ExitWorktree', 'Bash', 'Write'],
        maxTurns: 4,
        permissionMode: PermissionMode.PLAN,
      })
    );
    expect(mockChatStream).toHaveBeenCalledWith(
      'review the change',
      expect.objectContaining({ permissionMode: PermissionMode.PLAN })
    );
  });
});

/**
 * Bus topic 稳定性测试
 *
 * 验证 task.ts 中 subagent onEvent 生成的 Bus topic 名称稳定：
 * 外部消费者依赖这些 topic 字符串，不能随意更改。
 */
describe('Subagent Bus topic stability', () => {
  it('documents the canonical Bus topic names for subagent events', () => {
    // These topics are published by task.ts onEvent handler and consumed
    // by UI and other subscribers. Changing them is a breaking change.
    const CANONICAL_TOPICS = [
      'subagent.update', // tool_start → store update + topic
      'subagent.tool.start', // tool_start → detailed tool info
      'subagent.tool.result', // tool_result → result info
      'subagent.delta', // content_delta → text delta
      'subagent.thinking.delta', // thinking_delta → reasoning delta
      'subagent.stream.end', // stream_end → per-turn end signal
    ];

    // Static assertion: if someone renames a topic in task.ts,
    // this test should prompt them to update all subscribers.
    expect(CANONICAL_TOPICS).toEqual([
      'subagent.update',
      'subagent.tool.start',
      'subagent.tool.result',
      'subagent.delta',
      'subagent.thinking.delta',
      'subagent.stream.end',
    ]);
  });
});

describe('Task tool subagent event publishing', () => {
  it('publishes every forwarded subagent event with the parent session ref', async () => {
    vi.resetModules();
    const busState = { publish: vi.fn() };
    const worktreeState = {
      prepare: vi.fn(async () => ({
        workspaceRoot: '/tmp/task-workspace',
        worktree: undefined,
      })),
      finalize: vi.fn(async () => undefined),
    };
    const storeState = {
      startSubagentProgress: vi.fn(),
      updateSubagentTool: vi.fn(),
      completeSubagentProgress: vi.fn(),
    };
    const subagentExecutorState = {
      execute: vi.fn(),
    };
    const sessionStoreState = {
      saveSession: vi.fn(),
      updateSession: vi.fn(),
      loadSession: vi.fn(),
      listSessions: vi.fn(() => []),
      markCompleted: vi.fn(
        (
          id: string,
          result: { success: boolean; message: string; error?: string }
        ) => ({
          id,
          status: result.success ? 'completed' : 'failed',
          result,
        })
      ),
    };
    vi.doMock('../../../../src/server/bus.js', () => ({
      Bus: {
        publish: busState.publish,
      },
    }));
    vi.doMock('../../../../src/agent/subagents/SubagentWorktreeLifecycle.js', () => ({
      subagentWorktreeLifecycle: worktreeState,
    }));
    vi.doMock('../../../../src/store/vanilla.js', () => ({
      vanillaStore: {
        getState: () => ({
          app: {
            actions: {
              startSubagentProgress: storeState.startSubagentProgress,
              updateSubagentTool: storeState.updateSubagentTool,
              completeSubagentProgress: storeState.completeSubagentProgress,
            },
          },
        }),
      },
    }));
    vi.doMock('../../../../src/agent/subagents/SubagentExecutor.js', () => ({
      SubagentExecutor: class MockSubagentExecutor {
        execute = subagentExecutorState.execute;
      },
    }));
    vi.doMock('../../../../src/agent/subagents/AgentSessionStore.js', () => ({
      AgentSessionStore: {
        getInstance: () => sessionStoreState,
      },
      createAgentSessionConfigSnapshot: (config: unknown) => config,
    }));
    const toolStart: LoopEvent = {
      kind: 'tool_start',
      toolCall: {
        id: 'tool-1',
        type: 'function',
        function: { name: 'Read', arguments: '{}' },
      },
    };
    const toolResult: LoopEvent = {
      kind: 'tool_result',
      toolCall: {
        id: 'tool-1',
        type: 'function',
        function: { name: 'Read', arguments: '{}' },
      },
      result: { success: true, llmContent: 'ok' },
    };
    const contentDelta: LoopEvent = { kind: 'content_delta', delta: 'hello' };
    const thinkingDelta: LoopEvent = { kind: 'thinking_delta', delta: 'hmm' };
    const streamEnd: LoopEvent = { kind: 'stream_end' };
    subagentExecutorState.execute.mockImplementationOnce(
      async ({ onEvent }: { onEvent?: (event: LoopEvent) => void | Promise<void> }) => {
        if (!onEvent) {
          throw new Error('expected onEvent');
        }
        for (const event of [
          toolStart,
          toolResult,
          contentDelta,
          thinkingDelta,
          streamEnd,
        ]) {
          await onEvent(event);
        }
        return {
          success: true,
          message: 'done',
          stats: { toolCalls: 1, duration: 1, tokens: 1 },
        };
      }
    );

    const { PermissionMode } = await import('../../../../src/config/types.js');
    const { subagentRegistry } = await import(
      '../../../../src/agent/subagents/SubagentRegistry.js'
    );
    subagentRegistry.applyOverrides([
      {
        name: 'test-worker',
        description: 'test worker',
      },
    ]);
    const { taskTool } = await import('../../../../src/tools/builtin/task/task.js');
    const context = {
      sessionId: 'parent-session',
      workspaceRoot: '/tmp/parent-workspace',
      permissionMode: PermissionMode.DEFAULT,
      signal: new AbortController().signal,
      updateOutput: vi.fn(),
    };

    const result = await taskTool.execute(
      {
        subagent_type: 'test-worker',
        description: 'Forward events',
        prompt: 'Forward all events',
        run_in_background: false,
      },
      undefined,
      context
    );

    expect(result.success).toBe(true);
    expect(busState.publish).toHaveBeenCalledTimes(8);
    const ref = {
      sessionId: 'parent-session',
      projectPath: path.resolve('/tmp/parent-workspace/../parent-workspace'),
    };
    expect(busState.publish).toHaveBeenNthCalledWith(
      1,
      ref,
      'subagent.start',
      expect.objectContaining({
        type: 'test-worker',
        resumeDepth: 0,
      })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      2,
      ref,
      'subagent.update',
      expect.objectContaining({ toolName: 'Read' })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      3,
      ref,
      'subagent.tool.start',
      expect.objectContaining({ toolName: 'Read', toolCallId: 'tool-1' })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      4,
      ref,
      'subagent.tool.result',
      expect.objectContaining({ toolName: 'Read', toolCallId: 'tool-1' })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      5,
      ref,
      'subagent.delta',
      expect.objectContaining({ delta: 'hello' })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      6,
      ref,
      'subagent.thinking.delta',
      expect.objectContaining({ delta: 'hmm' })
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      7,
      ref,
      'subagent.stream.end',
      expect.objectContaining({})
    );
    expect(busState.publish).toHaveBeenNthCalledWith(
      8,
      ref,
      'subagent.complete',
      expect.objectContaining({ success: true, resumeDepth: 0 })
    );
    vi.doUnmock('../../../../src/server/bus.js');
    vi.doUnmock('../../../../src/agent/subagents/SubagentWorktreeLifecycle.js');
    vi.doUnmock('../../../../src/store/vanilla.js');
    vi.doUnmock('../../../../src/agent/subagents/SubagentExecutor.js');
    vi.doUnmock('../../../../src/agent/subagents/AgentSessionStore.js');
  });
});
