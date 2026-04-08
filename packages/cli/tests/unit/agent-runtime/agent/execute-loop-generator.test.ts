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
        displayContent: 'file content',
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
});
