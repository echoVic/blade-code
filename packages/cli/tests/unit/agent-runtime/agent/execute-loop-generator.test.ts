/**
 * executeLoopGenerator unit tests
 *
 * Tests the main async-generator loop behavior with fully mocked external dependencies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ===== Mock ALL external modules before imports =====

vi.mock('nanoid', () => ({ nanoid: () => 'mock-nanoid' }));

vi.mock('../../../../src/context/CompactionService.js', () => ({
  CompactionService: { compact: vi.fn() },
}));

vi.mock('../../../../src/context/ReactiveCompaction.js', () => ({
  ReactiveCompaction: vi.fn().mockImplementation(() => ({
    tryReactiveCompact: vi.fn().mockResolvedValue({ success: false, messages: [] }),
    reset: vi.fn(),
  })),
}));

vi.mock('../../../../src/context/SnipCompaction.js', () => ({
  snipCompact: vi.fn().mockReturnValue({ messages: [], snippedCount: 0 }),
}));

vi.mock('../../../../src/context/ToolResultBudget.js', () => ({
  applyToolResultBudget: vi.fn((content: unknown) => content),
}));

vi.mock('../../../../src/context/TokenBudget.js', () => ({
  createBudgetTracker: vi.fn().mockReturnValue({
    budget: 100000,
    usage: 0,
    consecutiveContinuations: 0,
    lastOutputDelta: 0,
    isSubagent: false,
  }),
  checkTokenBudget: vi.fn().mockReturnValue('continue'),
  recordOutput: vi.fn((tracker: unknown) => tracker),
}));

vi.mock('../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: vi.fn().mockReturnValue({
      executeStopHooks: vi.fn().mockResolvedValue({ shouldStop: true }),
    }),
  },
}));

vi.mock('../../../../src/skills/index.js', () => ({
  injectSkillsMetadata: vi.fn((tools: unknown) => tools),
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));

vi.mock('../../../../src/agent/loop/StreamingToolExecutor.js', () => ({
  StreamingToolExecutor: vi.fn(),
}));

// ===== Imports (after mocks) =====

import { executeLoopGenerator } from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../../src/agent/loop/types.js';
import type { ChatContext, LoopOptions, LoopResult } from '../../../../src/agent/types.js';

// ===== Helpers =====

function createMockDeps(overrides: Partial<LoopDependencies> = {}): LoopDependencies {
  const mockRegistry = {
    get: vi.fn().mockReturnValue({ isConcurrencySafe: true, kind: 'readonly' }),
    getFunctionDeclarationsByMode: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  };

  return {
    chatService: {
      chat: vi.fn().mockResolvedValue({
        content: 'Hello from LLM',
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      }),
      streamChat: vi.fn(),
      getConfig: vi.fn().mockReturnValue({
        stream: false,
        model: 'test-model',
        apiKey: 'key',
        maxOutputTokens: 4096,
      }),
      updateConfig: vi.fn(),
    } as any,
    executionPipeline: {
      getRegistry: vi.fn().mockReturnValue(mockRegistry),
      execute: vi.fn(),
    } as any,
    executionEngine: undefined,
    config: {
      maxTurns: 10,
      compactionThreshold: 0.8,
    } as any,
    runtimeOptions: {} as any,
    currentModelMaxContextTokens: 100000,
    applySkillToolRestrictions: vi.fn((tools: unknown) => tools),
    ...overrides,
  } as unknown as LoopDependencies;
}

function createMockContext(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    messages: [],
    sessionId: 'test-session',
    userId: 'test-user',
    workspaceRoot: '/tmp/test',
    permissionMode: 'normal' as any,
    ...overrides,
  } as ChatContext;
}

async function drainGenerator(
  gen: AsyncGenerator<LoopEvent, LoopResult, void>,
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let iterResult: IteratorResult<LoopEvent, LoopResult>;
  while (!(iterResult = await gen.next()).done) {
    events.push(iterResult.value);
  }
  return { events, result: iterResult.value };
}

function createMockContextManager() {
  const ids = ['msg-user-1', 'msg-assistant-1', 'msg-user-2', 'msg-assistant-2'];
  return {
    saveMessage: vi.fn().mockImplementation(async () => ids.shift() ?? `msg-${Date.now()}`),
    saveToolUse: vi.fn(),
    saveToolResult: vi.fn(),
    saveCompaction: vi.fn(),
  };
}

// ===== Tests =====

describe('executeLoopGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. Simple text response — no tool calls
  // ------------------------------------------------------------------
  describe('simple text response (no tool calls)', () => {
    it('should yield turn_start & token_usage and return success with finalMessage', async () => {
      const deps = createMockDeps();
      const context = createMockContext();

      const gen = executeLoopGenerator(
        deps,
        'Hello',
        context,
        { stream: false } as LoopOptions,
        'You are a helpful assistant.',
      );

      const { events, result } = await drainGenerator(gen);

      // Verify events
      const turnStartEvents = events.filter((e) => e.kind === 'turn_start');
      expect(turnStartEvents.length).toBe(1);
      expect(turnStartEvents[0]).toMatchObject({
        kind: 'turn_start',
        turn: 1,
      });

      const tokenUsageEvents = events.filter((e) => e.kind === 'token_usage');
      expect(tokenUsageEvents.length).toBe(1);
      expect(tokenUsageEvents[0]).toMatchObject({
        kind: 'token_usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          maxContextTokens: 100000,
        },
      });

      // Verify result
      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Hello from LLM');
      expect(result.metadata?.turnsCount).toBe(1);
      expect(result.metadata?.toolCallsCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // 2. maxTurns=0 → returns chat_disabled immediately
  // ------------------------------------------------------------------
  describe('maxTurns=0 → chat_disabled', () => {
    it('should return chat_disabled error with no events yielded', async () => {
      const deps = createMockDeps({
        runtimeOptions: { maxTurns: 0 } as any,
      });
      const context = createMockContext();

      const gen = executeLoopGenerator(
        deps,
        'Hello',
        context,
        undefined,
        undefined,
      );

      const { events, result } = await drainGenerator(gen);

      expect(events.length).toBe(0);
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('chat_disabled');
      expect(result.metadata?.turnsCount).toBe(0);
      expect(result.metadata?.toolCallsCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // 3. Tool call → tool result → final response (2 turns)
  // ------------------------------------------------------------------
  describe('tool call → tool result → final response (2 turns)', () => {
    it('should execute tool calls and return the final LLM response', async () => {
      const deps = createMockDeps();
      const context = createMockContext();

      // First LLM call: returns a tool call
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'Read', arguments: '{"path":"foo"}' },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'tool_calls',
        })
        // Second LLM call: final text response
        // NOTE: avoid content ending with '...' as that triggers incomplete-intent retry
        .mockResolvedValueOnce({
          content: 'Based on the file, here is the answer.',
          toolCalls: undefined,
          usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
          finishReason: 'stop',
        });

      // Tool execution result
      const executeMock = deps.executionPipeline.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: true,
        llmContent: 'file content',
        metadata: undefined,
      });

      const gen = executeLoopGenerator(
        deps,
        'Read the file foo',
        context,
        { stream: false } as LoopOptions,
        'You are a helpful assistant.',
      );

      const { events, result } = await drainGenerator(gen);

      // Verify turn_start events (two turns)
      const turnStartEvents = events.filter((e) => e.kind === 'turn_start');
      expect(turnStartEvents.length).toBe(2);
      expect(turnStartEvents[0]).toMatchObject({ kind: 'turn_start', turn: 1 });
      expect(turnStartEvents[1]).toMatchObject({ kind: 'turn_start', turn: 2 });

      // Verify tool_start event
      const toolStartEvents = events.filter((e) => e.kind === 'tool_start');
      expect(toolStartEvents.length).toBe(1);
      if (toolStartEvents[0].kind === 'tool_start' && toolStartEvents[0].toolCall.type === 'function') {
        expect(toolStartEvents[0].toolCall.function.name).toBe('Read');
      }

      // Verify tool_result event
      const toolResultEvents = events.filter((e) => e.kind === 'tool_result');
      expect(toolResultEvents.length).toBe(1);
      if (toolResultEvents[0].kind === 'tool_result') {
        expect(toolResultEvents[0].result.success).toBe(true);
        expect(toolResultEvents[0].result.llmContent).toBe('file content');
      }

      // Verify token_usage events (one per turn)
      const tokenUsageEvents = events.filter((e) => e.kind === 'token_usage');
      expect(tokenUsageEvents.length).toBe(2);

      // Verify final result
      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Based on the file, here is the answer.');
      expect(result.metadata?.turnsCount).toBe(2);
      expect(result.metadata?.toolCallsCount).toBe(1);

      // Verify chat was called twice
      expect(chatMock).toHaveBeenCalledTimes(2);

      // Verify tool was executed
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledWith(
        'Read',
        { path: 'foo' },
        expect.objectContaining({ sessionId: 'test-session' }),
      );
    });

    it('should persist and write back the tool result before returning when tool requests loop exit', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextManager),
        } as any,
      });
      const context = createMockContext();

      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'Edit', arguments: '{"file_path":"/tmp/demo.ts"}' },
          },
        ],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        finishReason: 'tool_calls',
      });

      const executeMock = deps.executionPipeline.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: false,
        llmContent: '已取消工具执行',
        error: {
          type: 'execution_error',
          message: '用户拒绝授权',
        },
        metadata: {
          summary: '已取消工具执行',
          shouldExitLoop: true,
        },
      });

      const gen = executeLoopGenerator(
        deps,
        'Edit the file',
        context,
        { stream: false } as LoopOptions,
        'You are a helpful assistant.',
      );

      const { result } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(contextManager.saveToolResult).toHaveBeenCalledTimes(1);
      expect(context.messages).toContainEqual({
        role: 'tool',
        tool_call_id: 'tc1',
        name: 'Edit',
        content: '用户拒绝授权',
      });
    });
  });

  // ------------------------------------------------------------------
  // 4. Abort signal → returns aborted
  // ------------------------------------------------------------------
  describe('abort signal → aborted result', () => {
    it('should return aborted error when signal is already aborted', async () => {
      const deps = createMockDeps();
      const context = createMockContext();

      const gen = executeLoopGenerator(
        deps,
        'Hello',
        context,
        { signal: AbortSignal.abort(), stream: false } as LoopOptions,
        undefined,
      );

      const { events, result } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
      expect(result.error?.message).toContain('中止');
    });
  });

  // ------------------------------------------------------------------
  // 5. API error → returns api_error
  // ------------------------------------------------------------------
  describe('API error → api_error result', () => {
    it('should return api_error when chatService.chat rejects', async () => {
      const deps = createMockDeps();
      const context = createMockContext();

      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockRejectedValueOnce(new Error('API failure'));

      const gen = executeLoopGenerator(
        deps,
        'Hello',
        context,
        { stream: false } as LoopOptions,
        undefined,
      );

      const { result } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('api_error');
      expect(result.error?.message).toBe('API failure');
    });
  });

  // ------------------------------------------------------------------
  // 6. Event protocol: delta 是唯一内容信号
  // ------------------------------------------------------------------
  describe('event protocol: delta-only content signals', () => {
    it('non-streaming turn emits content_delta but NOT content_complete', async () => {
      const deps = createMockDeps();
      (deps.chatService.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Hello world',
        reasoningContent: 'I should greet',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      });
      const context = createMockContext();

      const { events } = await drainGenerator(
        executeLoopGenerator(deps, 'Hi', context, { stream: false } as LoopOptions, undefined),
      );

      // delta 应存在
      const contentDeltas = events.filter((e) => e.kind === 'content_delta');
      expect(contentDeltas.length).toBe(1);
      expect((contentDeltas[0] as { delta: string }).delta).toBe('Hello world');

      const thinkingDeltas = events.filter((e) => e.kind === 'thinking_delta');
      expect(thinkingDeltas.length).toBe(1);
      expect((thinkingDeltas[0] as { delta: string }).delta).toBe('I should greet');

      // stream_end 必须存在
      expect(events.filter((e) => e.kind === 'stream_end')).toHaveLength(1);
    });

    it('non-streaming turn with empty content still emits stream_end', async () => {
      const deps = createMockDeps();
      (deps.chatService.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: '',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
        finishReason: 'stop',
      });
      const context = createMockContext();

      const { events } = await drainGenerator(
        executeLoopGenerator(deps, 'Hi', context, { stream: false } as LoopOptions, undefined),
      );

      expect(events.filter((e) => e.kind === 'content_delta')).toHaveLength(0);
      expect(events.filter((e) => e.kind === 'stream_end')).toHaveLength(1);
    });

    it('event ordering: turn_start → content_delta → stream_end', async () => {
      const deps = createMockDeps();
      (deps.chatService.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Result',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      });
      const context = createMockContext();

      const { events } = await drainGenerator(
        executeLoopGenerator(deps, 'Hi', context, { stream: false } as LoopOptions, undefined),
      );

      const kinds = events.map((e) => e.kind);
      const turnIdx = kinds.indexOf('turn_start');
      const deltaIdx = kinds.indexOf('content_delta');
      const endIdx = kinds.indexOf('stream_end');

      expect(turnIdx).toBeGreaterThanOrEqual(0);
      expect(deltaIdx).toBeGreaterThan(turnIdx);
      expect(endIdx).toBeGreaterThan(deltaIdx);
    });
  });

  // ------------------------------------------------------------------
  // 7. Continue 分支必须保留 assistant 消息到历史
  // ------------------------------------------------------------------
  describe('continue branches preserve assistant messages in history', () => {
    it('incomplete-intent retry preserves assistant-before-control order in history', async () => {
      const deps = createMockDeps();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      // Turn 1: 触发 incomplete-intent（以 "让我先" 结尾）
      chatMock.mockResolvedValueOnce({
        content: '让我先查看一下文件',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      });
      // Turn 2: 正常完成
      chatMock.mockResolvedValueOnce({
        content: 'Done.',
        toolCalls: undefined,
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
        finishReason: 'stop',
      });

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(deps, 'Fix the bug', context, { stream: false } as LoopOptions, undefined),
      );

      expect(result.success).toBe(true);
      // context.messages 应包含 turn 1 的 assistant 消息
      const assistantMessages = context.messages.filter(
        (m: { role: string }) => m.role === 'assistant',
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      // 第一�� assistant 消息是 incomplete-intent 那轮的输出
      expect(assistantMessages[0].content).toBe('让我先查看一下文件');

      // 关键顺序断言：assistant 消息必须紧挨在 retry 控制消息之前
      const allMessages = context.messages;
      const firstAssistantIdx = allMessages.findIndex(
        (m: { role: string; content: unknown }) =>
          m.role === 'assistant' && m.content === '让我先查看一下文件',
      );
      expect(firstAssistantIdx).toBeGreaterThanOrEqual(0);
      // 下一条消息应该是 retry 控制消息（user role）
      const nextMsg = allMessages[firstAssistantIdx + 1];
      expect(nextMsg).toBeDefined();
      expect(nextMsg.role).toBe('user');
    });

    it('stop-hook continue preserves assistant-before-control order in history', async () => {
      // 覆盖 HookManager mock：第一次 shouldStop=false（continue），第二次 shouldStop=true
      const { HookManager } = await import('../../../../src/hooks/HookManager.js');
      const mockHookMgr = (HookManager.getInstance as ReturnType<typeof vi.fn>)();
      (mockHookMgr.executeStopHooks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ shouldStop: false, reason: 'keep going' })
        .mockResolvedValueOnce({ shouldStop: true });

      const deps = createMockDeps();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      // Turn 1: 正常内容，stop hook 说 continue
      chatMock.mockResolvedValueOnce({
        content: 'First part of work',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
      });
      // Turn 2: 正常完成，stop hook 说 stop
      chatMock.mockResolvedValueOnce({
        content: 'All done.',
        toolCalls: undefined,
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
        finishReason: 'stop',
      });

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(deps, 'Do the work', context, { stream: false } as LoopOptions, undefined),
      );

      expect(result.success).toBe(true);
      // context.messages 应包含 turn 1 的 assistant 消息
      const assistantMessages = context.messages.filter(
        (m: { role: string }) => m.role === 'assistant',
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      expect(assistantMessages[0].content).toBe('First part of work');

      // 关键顺序断言：assistant 消息必须紧挨在 continue 控制消息之前
      const allMessages = context.messages;
      const firstAssistantIdx = allMessages.findIndex(
        (m: { role: string; content: unknown }) =>
          m.role === 'assistant' && m.content === 'First part of work',
      );
      expect(firstAssistantIdx).toBeGreaterThanOrEqual(0);
      // 下一条消息应该是 continue 控制消息（user role）
      const nextMsg = allMessages[firstAssistantIdx + 1];
      expect(nextMsg).toBeDefined();
      expect(nextMsg.role).toBe('user');
    });

    it('persists retry branch messages with a continuous parent UUID chain', async () => {
      const contextMgr = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextMgr),
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: '让我先查看一下文件',
          toolCalls: undefined,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: 'Done.',
          toolCalls: undefined,
          usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
          finishReason: 'stop',
        });

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Fix the bug',
          context,
          { stream: false } as LoopOptions,
          undefined,
        ),
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]: [string, string, unknown, string | null]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          }),
        ),
      ).toEqual([
        {
          sessionId: 'test-session',
          role: 'user',
          content: 'Fix the bug',
          parentUuid: null,
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: '让我先查看一下文件',
          parentUuid: 'msg-user-1',
        },
        {
          sessionId: 'test-session',
          role: 'user',
          content: '请执行你提到的操作，不要只是描述。',
          parentUuid: 'msg-assistant-1',
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: 'Done.',
          parentUuid: 'msg-user-2',
        },
      ]);
    });

    it('persists stop-hook continue messages with a continuous parent UUID chain', async () => {
      const { HookManager } = await import('../../../../src/hooks/HookManager.js');
      const mockHookMgr = (HookManager.getInstance as ReturnType<typeof vi.fn>)();
      (mockHookMgr.executeStopHooks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ shouldStop: false, continueReason: 'keep going' })
        .mockResolvedValueOnce({ shouldStop: true });

      const contextMgr = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextMgr),
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: 'First part of work',
          toolCalls: undefined,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: 'All done.',
          toolCalls: undefined,
          usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
          finishReason: 'stop',
        });

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Do the work',
          context,
          { stream: false } as LoopOptions,
          undefined,
        ),
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]: [string, string, unknown, string | null]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          }),
        ),
      ).toEqual([
        {
          sessionId: 'test-session',
          role: 'user',
          content: 'Do the work',
          parentUuid: null,
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: 'First part of work',
          parentUuid: 'msg-user-1',
        },
        {
          sessionId: 'test-session',
          role: 'user',
          content: '\n\n<system-reminder>\nkeep going\n</system-reminder>',
          parentUuid: 'msg-assistant-1',
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: 'All done.',
          parentUuid: 'msg-user-2',
        },
      ]);
    });
  });

  describe('recovery branch persistence', () => {
    it('persists recovery assistant and prompt with a continuous parent UUID chain', async () => {
      const contextMgr = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextMgr),
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: 'Partial output',
          toolCalls: undefined,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: 'length',
        })
        .mockResolvedValueOnce({
          content: 'Final output.',
          toolCalls: undefined,
          usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
          finishReason: 'stop',
        });

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Write the answer',
          context,
          { stream: false } as LoopOptions,
          undefined,
        ),
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]: [string, string, unknown, string | null]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          }),
        ),
      ).toEqual([
        {
          sessionId: 'test-session',
          role: 'user',
          content: 'Write the answer',
          parentUuid: null,
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: 'Partial output',
          parentUuid: 'msg-user-1',
        },
        {
          sessionId: 'test-session',
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. ' +
            'Pick up mid-thought if that is where the cut happened. ' +
            'Break remaining work into smaller pieces.',
          parentUuid: 'msg-assistant-1',
        },
        {
          sessionId: 'test-session',
          role: 'assistant',
          content: 'Final output.',
          parentUuid: 'msg-user-2',
        },
      ]);
    });
  });
});
