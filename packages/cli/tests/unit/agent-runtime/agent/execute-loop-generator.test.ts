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
  microCompact: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../../src/context/ToolResultBudget.js', () => ({
  applyToolResultBudget: vi.fn((content: unknown) => content),
  MessageBudgetTracker: class MessageBudgetTracker {
    track() {
      /* noop */
    }
    remaining() {
      return 200000;
    }
    isExhausted() {
      return false;
    }
    reset() {
      /* noop */
    }
  },
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

import { ExecutionEngine } from '../../../../src/agent/ExecutionEngine.js';
import { MAX_VERIFICATION_RETRIES } from '../../../../src/agent/loop/completionPolicy.js';
import {
  checkAndCompactInLoop,
  executeLoopGenerator,
} from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../../src/agent/loop/types.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
} from '../../../../src/agent/types.js';
import { CompactionService } from '../../../../src/context/CompactionService.js';
import { ContextManager } from '../../../../src/context/ContextManager.js';

// ===== Helpers =====

function createMockDeps(overrides: Partial<LoopDependencies> = {}): LoopDependencies {
  const mockRegistry = {
    get: vi.fn().mockReturnValue({ isConcurrencySafe: true, kind: 'readonly' }),
    getFunctionDeclarationsByMode: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    getDeferredToolsListing: vi.fn().mockReturnValue(''),
    deferredToolManager: undefined,
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
    toolExecutor: {
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
  gen: AsyncGenerator<LoopEvent, LoopResult, void>
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
    saveMessage: vi
      .fn()
      .mockImplementation(async () => ids.shift() ?? `msg-${Date.now()}`),
    saveToolUse: vi.fn(),
    saveToolResult: vi.fn(),
    saveCompaction: vi.fn(),
  };
}

function createTypedPersistenceHarness(options?: { rejectToolUse?: boolean }) {
  const baseDeps = createMockDeps();
  const contextManager = new ContextManager({
    projectPath: '/tmp/blade-execute-loop-durable-identity',
  });
  let messageIndex = 0;
  const saveMessage = vi
    .spyOn(contextManager, 'saveMessage')
    .mockImplementation(async () => `durable-message-${++messageIndex}`);
  const saveToolUse = vi.spyOn(contextManager, 'saveToolUse');
  if (options?.rejectToolUse) {
    saveToolUse.mockRejectedValue(new Error('durable tool-use persistence failed'));
  } else {
    saveToolUse.mockResolvedValue('durable-tool-id');
  }
  const saveToolResult = vi
    .spyOn(contextManager, 'saveToolResult')
    .mockResolvedValue('durable-result-message-id');
  const executionEngine = new ExecutionEngine(
    baseDeps.chatService,
    contextManager,
    '/tmp/blade-execute-loop-durable-identity'
  );
  const deps: LoopDependencies = { ...baseDeps, executionEngine };
  return { deps, saveMessage, saveToolUse, saveToolResult };
}

// ===== Tests =====

describe('executeLoopGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('compaction lifecycle', () => {
    it('yields start while the compaction request is still pending', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-read-before-compact',
              type: 'function',
              function: { name: 'Read', arguments: '{"path":"package.json"}' },
            },
          ],
          usage: {
            promptTokens: 90_000,
            completionTokens: 20,
            totalTokens: 90_020,
          },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Compaction finished and work continued.',
          toolCalls: undefined,
          usage: { promptTokens: 1_000, completionTokens: 20, totalTokens: 1_020 },
          finishReason: 'stop',
        });
      (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        llmContent: '{"name":"fixture"}',
      });

      let markCompactionRequested: () => void = () => undefined;
      const compactionRequested = new Promise<void>((resolve) => {
        markCompactionRequested = resolve;
      });
      let releaseCompaction: () => void = () => undefined;
      vi.mocked(CompactionService.compact).mockImplementationOnce(() => {
        markCompactionRequested();
        return new Promise((resolve) => {
          releaseCompaction = () =>
            resolve({
              success: true,
              summary: 'summary',
              preTokens: 90_000,
              postTokens: 1_000,
              filesIncluded: [],
              compactedMessages: [{ role: 'system', content: 'summary' }],
              boundaryMessage: { role: 'system', content: '' },
              summaryMessage: { role: 'user', content: 'summary' },
            });
        });
      });

      const generator = executeLoopGenerator(
        deps,
        'Read package.json before continuing.',
        context,
        { stream: false } as LoopOptions,
        undefined
      );

      let sawStreamEnd = false;
      let sawTokenUsage = false;
      let sawToolResult = false;
      while (!sawStreamEnd || !sawTokenUsage || !sawToolResult) {
        const next = await generator.next();
        expect(next.done).toBe(false);
        if (!next.done && next.value.kind === 'stream_end') sawStreamEnd = true;
        if (!next.done && next.value.kind === 'token_usage') sawTokenUsage = true;
        if (!next.done && next.value.kind === 'tool_result') sawToolResult = true;
      }

      const pendingEvent = generator.next();
      const timeout = Symbol('timeout');
      const observed = await Promise.race([
        pendingEvent,
        new Promise<typeof timeout>((resolve) =>
          setTimeout(() => resolve(timeout), 25)
        ),
      ]);

      if (observed === timeout) {
        await compactionRequested;
        expect(CompactionService.compact).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            activeTask: 'Read package.json before continuing.',
          })
        );
        releaseCompaction();
        await pendingEvent;
        expect(observed).not.toBe(timeout);
        return;
      }
      expect(observed).toMatchObject({
        done: false,
        value: { kind: 'compaction', phase: 'start' },
      });

      const endEvent = generator.next();
      await compactionRequested;
      expect(CompactionService.compact).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          activeTask: 'Read package.json before continuing.',
        })
      );
      releaseCompaction();
      expect(await endEvent).toMatchObject({
        done: false,
        value: { kind: 'compaction', phase: 'end' },
      });
    });

    it('applies post-compaction hysteresis while preserving emergency compaction', async () => {
      const deps = createMockDeps();
      (deps.chatService.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        stream: false,
        model: 'test-model',
        apiKey: 'key',
        maxContextTokens: 100_000,
        maxOutputTokens: 4_096,
      });
      const compacted: Awaited<ReturnType<typeof CompactionService.compact>> = {
        success: true,
        summary: 'summary',
        preTokens: 85_000,
        postTokens: 1_000,
        filesIncluded: [],
        compactedMessages: [{ role: 'user', content: 'summary' }],
        boundaryMessage: { role: 'system', content: '' },
        summaryMessage: { role: 'user', content: 'summary' },
      };
      vi.mocked(CompactionService.compact)
        .mockResolvedValueOnce(compacted)
        .mockResolvedValueOnce(compacted);
      const context = createMockContext({
        messages: [{ role: 'user', content: 'large history' }],
      });
      const compactionState: { lastCompactionTurn?: number } = {};

      const runCheck = async (turn: number, tokens: number) => {
        const generator = checkAndCompactInLoop(
          deps,
          context,
          turn,
          tokens,
          undefined,
          undefined,
          'active task',
          compactionState
        );
        let step = await generator.next();
        while (!step.done) {
          step = await generator.next();
        }
        return step.value;
      };

      await expect(runCheck(1, 85_000)).resolves.toBe('compacted');
      await expect(runCheck(2, 85_000)).resolves.toBe('none');
      expect(CompactionService.compact).toHaveBeenCalledTimes(1);

      await expect(runCheck(2, 92_000)).resolves.toBe('compacted');
      expect(CompactionService.compact).toHaveBeenCalledTimes(2);
    });
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
        'You are a helpful assistant.'
      );

      const { result, events } = await drainGenerator(gen);

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

    it('persists a direct durable input with its inbox identity', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const context = createMockContext();

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Durable initial request.',
          context,
          { stream: false, inputMessageId: 'initial-input-1' },
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(contextManager.saveMessage).toHaveBeenCalledWith(
        'test-session',
        'user',
        'Durable initial request.',
        null,
        { inboxMessageId: 'initial-input-1' },
        undefined
      );
      expect(context.messages).toContainEqual({
        role: 'user',
        content: 'Durable initial request.',
        metadata: { inboxMessageId: 'initial-input-1' },
      });
    });

    it('does not call the model when a direct durable input cannot be persisted', async () => {
      const contextManager = createMockContextManager();
      contextManager.saveMessage.mockReset().mockResolvedValue(null);
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Do not lose this request.',
          createMockContext(),
          { stream: false, inputMessageId: 'initial-input-failure' },
          undefined
        )
      );

      expect(result.success).toBe(false);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('applies mid-turn steering before accepting the model final response', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: 'Initial answer',
          toolCalls: undefined,
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: 'Steered answer',
          toolCalls: undefined,
          usage: { promptTokens: 130, completionTokens: 20, totalTokens: 150 },
          finishReason: 'stop',
        });

      let drainCount = 0;
      const steeringMessage = {
        id: 'steer-1',
        content: 'Use the updated requirement.',
        queuedAt: Date.now(),
        recovered: false,
      };
      const turnSteering = {
        drain: vi.fn(async () => {
          drainCount++;
          return drainCount === 2 ? [steeringMessage] : [];
        }),
        drainOrSeal: vi.fn(async () => ({ messages: [], sealed: true })),
      };

      const { events, result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Use the initial requirement.',
          context,
          { stream: false, turnSteering } as LoopOptions,
          undefined
        )
      );

      expect(result).toMatchObject({
        success: true,
        finalMessage: 'Steered answer',
      });
      expect(events).toContainEqual({
        kind: 'steering_applied',
        messageIds: ['steer-1'],
        count: 1,
        recovered: 0,
        delivery: 'current_turn',
      });
      expect(contextManager.saveMessage).toHaveBeenCalledWith(
        'test-session',
        'user',
        'Use the updated requirement.',
        expect.any(String),
        { inboxMessageId: 'steer-1' },
        undefined
      );
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(chatMock.mock.calls[1]?.[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'Initial answer' }),
          expect.objectContaining({
            role: 'user',
            content: 'Use the updated requirement.',
          }),
        ])
      );
      expect(context.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'Use the updated requirement.',
          }),
        ])
      );
    });

    it('retains persisted durable steering on partial persistence failure', async () => {
      const contextManager = createMockContextManager();
      contextManager.saveMessage
        .mockReset()
        .mockResolvedValueOnce('initial-user')
        .mockResolvedValueOnce('initial-assistant')
        .mockResolvedValueOnce('steering-one')
        .mockRejectedValueOnce(new Error('disk unavailable'));
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: 'Initial answer',
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        finishReason: 'stop',
      });
      let drainCount = 0;
      const turnSteering = {
        drain: vi.fn(async () => {
          drainCount++;
          return drainCount === 2
            ? [
                {
                  id: 'steer-1',
                  content: 'First durable update.',
                  queuedAt: Date.now(),
                  recovered: false,
                },
                {
                  id: 'steer-2',
                  content: 'Second durable update.',
                  queuedAt: Date.now(),
                  recovered: false,
                },
              ]
            : [];
        }),
        drainOrSeal: vi.fn(async () => ({ messages: [], sealed: true })),
      };

      const context = createMockContext();
      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Initial request.',
          context,
          { stream: false, turnSteering },
          undefined
        )
      );

      expect(result.success).toBe(false);
      expect(context.messages).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: 'First durable update.',
          metadata: { inboxMessageId: 'steer-1' },
        })
      );
    });

    it('starts a pending-only turn without persisting a synthetic empty prompt', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: 'BETA_VALUE',
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        finishReason: 'stop',
      });
      let drained = false;
      const turnSteering = {
        drain: vi.fn(async () => {
          if (drained) return [];
          drained = true;
          return [
            {
              id: 'recovered-follow-up',
              content: 'Reply with BETA_VALUE only.',
              queuedAt: Date.now(),
              recovered: true,
            },
          ];
        }),
        drainOrSeal: vi.fn(async () => ({ messages: [], sealed: true })),
      };

      const { events, result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          '',
          createMockContext(),
          { stream: false, pendingInputOnly: true, turnSteering },
          undefined
        )
      );

      expect(result).toMatchObject({
        success: true,
        finalMessage: 'BETA_VALUE',
      });
      expect(events).toContainEqual({
        kind: 'steering_applied',
        messageIds: ['recovered-follow-up'],
        count: 1,
        recovered: 1,
        delivery: 'next_turn',
      });
      expect(contextManager.saveMessage).toHaveBeenCalledWith(
        'test-session',
        'user',
        'Reply with BETA_VALUE only.',
        null,
        { inboxMessageId: 'recovered-follow-up' },
        undefined
      );
      expect(
        contextManager.saveMessage.mock.calls.some((call: unknown[]) => call[2] === '')
      ).toBe(false);
    });

    it('reuses a transcript-committed inbox message after a pre-model crash', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: () => contextManager,
        } as any,
      });
      const context = createMockContext();
      context.messages = [
        {
          role: 'user',
          content: 'Resume this exact durable request.',
          metadata: { inboxMessageId: 'durable-crash-window' },
        },
      ];
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: 'resumed',
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        finishReason: 'stop',
      });
      let drained = false;
      const turnSteering = {
        drain: vi.fn(async () => {
          if (drained) return [];
          drained = true;
          return [
            {
              id: 'durable-crash-window',
              content: 'Resume this exact durable request.',
              queuedAt: Date.now(),
              recovered: true,
            },
          ];
        }),
        drainOrSeal: vi.fn(async () => ({ messages: [], sealed: true })),
      };

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          '',
          context,
          { stream: false, pendingInputOnly: true, turnSteering },
          undefined
        )
      );

      expect(result).toMatchObject({ success: true, finalMessage: 'resumed' });
      expect(
        contextManager.saveMessage.mock.calls.filter(
          (call: unknown[]) =>
            call[1] === 'user' && call[2] === 'Resume this exact durable request.'
        )
      ).toHaveLength(0);
      expect(
        context.messages.filter(
          (message) =>
            message.metadata &&
            typeof message.metadata === 'object' &&
            !Array.isArray(message.metadata) &&
            message.metadata.inboxMessageId === 'durable-crash-window'
        )
      ).toHaveLength(1);
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

      const gen = executeLoopGenerator(deps, 'Hello', context, undefined, undefined);

      const { result, events } = await drainGenerator(gen);

      expect(events.length).toBe(0);
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('chat_disabled');
      expect(result.metadata?.turnsCount).toBe(0);
      expect(result.metadata?.toolCallsCount).toBe(0);
    });
  });

  it('enforces an explicit turn limit for subagents in yolo mode', async () => {
    const deps = createMockDeps({
      runtimeOptions: { maxTurns: 1 } as any,
    });
    const context = createMockContext({
      permissionMode: 'yolo' as any,
      subagentInfo: {
        parentSessionId: 'parent-session',
        subagentType: 'reviewer',
        isSidechain: true,
      },
    });
    const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
    chatMock.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'tc-turn-limit',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"foo"}' },
        },
      ],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      finishReason: 'tool_calls',
    });
    (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      llmContent: 'file content',
    });

    const { result } = await drainGenerator(
      executeLoopGenerator(
        deps,
        'Read the file',
        context,
        { stream: false } as LoopOptions,
        undefined
      )
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('max_turns_exceeded');
    expect(result.metadata?.turnsCount).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('enforces an explicit turn limit for the main agent in yolo mode', async () => {
    const deps = createMockDeps({
      runtimeOptions: { maxTurns: 1 } as any,
    });
    const context = createMockContext({
      permissionMode: 'yolo' as any,
    });
    const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
    chatMock.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'tc-main-turn-limit',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"echo retry"}' },
        },
      ],
      finishReason: 'tool_calls',
    });
    (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      llmContent: 'blocked',
    });

    const { result } = await drainGenerator(
      executeLoopGenerator(
        deps,
        'Run the command once.',
        context,
        { stream: false } as LoopOptions,
        undefined
      )
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('max_turns_exceeded');
    expect(result.metadata?.turnsCount).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // 3. Tool call → tool result → final response (2 turns)
  // ------------------------------------------------------------------
  describe('tool call → tool result → final response (2 turns)', () => {
    it('decodes a double-encoded JSON object before tool validation', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-double-encoded',
              type: 'function',
              function: {
                name: 'Read',
                arguments: JSON.stringify(JSON.stringify({ path: 'foo' })),
              },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Read completed.',
          toolCalls: undefined,
          usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
          finishReason: 'stop',
        });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: true,
        llmContent: 'file content',
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Read the file',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledWith(
        'Read',
        { path: 'foo' },
        expect.any(Object)
      );
    });

    it('should execute tool calls and return the final LLM response', async () => {
      const { deps, saveToolResult } = createTypedPersistenceHarness();
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
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
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
        'You are a helpful assistant.'
      );

      const { result, events } = await drainGenerator(gen);

      // Verify turn_start events (two turns)
      const turnStartEvents = events.filter((e) => e.kind === 'turn_start');
      expect(turnStartEvents.length).toBe(2);
      expect(turnStartEvents[0]).toMatchObject({ kind: 'turn_start', turn: 1 });
      expect(turnStartEvents[1]).toMatchObject({ kind: 'turn_start', turn: 2 });

      // Verify tool_start event
      const toolStartEvents = events.filter((e) => e.kind === 'tool_start');
      expect(toolStartEvents.length).toBe(1);
      if (
        toolStartEvents[0].kind === 'tool_start' &&
        toolStartEvents[0].toolCall.type === 'function'
      ) {
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
        expect.objectContaining({ sessionId: 'test-session' })
      );
      expect(saveToolResult).toHaveBeenCalledWith(
        'test-session',
        'durable-tool-id',
        'Read',
        'file content',
        'durable-tool-id',
        undefined,
        undefined,
        undefined
      );
      expect(context.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'tc1',
          name: 'Read',
        })
      );
    });

    it('falls back to the provider tool ID when durable tool-use persistence fails', async () => {
      const { deps, saveToolResult } = createTypedPersistenceHarness({
        rejectToolUse: true,
      });
      const context = createMockContext();
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
        .mockResolvedValueOnce({
          content: 'Done.',
          toolCalls: undefined,
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'stop',
        });
      (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        llmContent: 'file content',
      });

      await drainGenerator(
        executeLoopGenerator(
          deps,
          'Read the file',
          context,
          { stream: false } as LoopOptions,
          'You are a helpful assistant.'
        )
      );

      expect(saveToolResult).toHaveBeenCalledWith(
        'test-session',
        'tc1',
        'Read',
        'file content',
        null,
        undefined,
        undefined,
        undefined
      );
      expect(context.messages).toContainEqual(
        expect.objectContaining({ role: 'tool', tool_call_id: 'tc1' })
      );
    });

    it('continues until an explicitly requested verification command succeeds', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: 'The source change is complete.',
          toolCalls: undefined,
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-verify',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"npm test"}',
              },
            },
          ],
          usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Tests pass and the fix is complete.',
          toolCalls: undefined,
          usage: { promptTokens: 160, completionTokens: 20, totalTokens: 180 },
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: true,
        llmContent: '1 test passed',
        metadata: {
          command: 'npm test',
          exit_code: 0,
        },
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Fix the bug and run npm test before finishing.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(chatMock).toHaveBeenCalledTimes(3);
      expect(executeMock).toHaveBeenCalledWith(
        'Bash',
        { command: 'npm test' },
        expect.objectContaining({ sessionId: 'test-session' })
      );
      expect(context.messages).toContainEqual({
        role: 'user',
        content: expect.stringContaining('explicitly required verification'),
      });
    });

    it('accepts structured verification evidence from a successful Task', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-delegate',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"reviewer","description":"fix","prompt":"fix and test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'The delegated fix and verification are complete.',
          toolCalls: undefined,
          finishReason: 'stop',
        });
      (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        llmContent: 'Subagent completed the change.',
        metadata: {
          subagentStatus: 'completed',
          verificationCommands: ['npm test'],
        },
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Delegate the bug fix and run npm test before finishing.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(context.messages).not.toContainEqual({
        role: 'user',
        content: expect.stringContaining('explicitly required verification'),
      });
    });

    it('writes successful Task outcome metadata for in-memory recovery', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'task-outcome-metadata',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"reviewer","description":"review","prompt":"review the change"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Review completed.',
          finishReason: 'stop',
        });
      (deps.toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        llmContent: 'No findings.',
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Delegate this review with the Task tool.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(context.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          name: 'Task',
          tool_call_id: 'task-outcome-metadata',
          metadata: {
            toolCallId: 'task-outcome-metadata',
            toolName: 'Task',
            error: null,
          },
        })
      );
    });

    it('continues until every explicitly requested verification category succeeds', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: 'The migration is complete.',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-test',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"npm test"}' },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Tests pass.',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-type-check',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"npm run type-check"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Both checks pass.',
          finishReason: 'stop',
        });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'tests passed',
          metadata: { command: 'npm test', exit_code: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'type-check passed',
          metadata: { command: 'npm run type-check', exit_code: 0 },
        });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Run npm run type-check and npm test; finish only after both pass.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(chatMock).toHaveBeenCalledTimes(5);
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(context.messages).toContainEqual({
        role: 'user',
        content: expect.stringContaining(
          'Missing successful verification categories: type-check'
        ),
      });
    });

    it('continues until an explicitly requested delegation succeeds', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: 'I completed the task directly.',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-delegate-required',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"repair","prompt":"repair and test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'The delegated repair completed.',
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: true,
        llmContent: 'Subagent repaired and verified the project.',
        metadata: {
          subagentStatus: 'completed',
          verificationCommands: ['npm test'],
        },
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Delegate this repair to channel-specialist with the Task tool.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledWith(
        'Task',
        expect.objectContaining({
          subagent_type: 'channel-specialist',
        }),
        expect.objectContaining({ sessionId: 'test-session' })
      );
      expect(context.messages).toContainEqual({
        role: 'user',
        content: expect.stringContaining('explicitly required delegation'),
      });
    });

    it('enforces delegation declared only by invocation requirements', async () => {
      const deps = createMockDeps();
      deps.runtimeOptions = {
        ...deps.runtimeOptions,
        appendSystemPrompt: 'Call Task exactly once before returning an answer.',
      };
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: 'I completed the work directly.',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-required-by-invocation',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"repair","prompt":"repair and test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'The delegated repair completed.',
          finishReason: 'stop',
        });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValue({
        success: true,
        llmContent: 'Subagent repaired the project.',
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Repair the project.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(context.messages).toContainEqual({
        role: 'user',
        content: expect.stringContaining('explicitly required delegation'),
      });
    });

    it('does not execute Task again after an exactly-once delegation succeeds', async () => {
      const deps = createMockDeps();
      deps.runtimeOptions = {
        ...deps.runtimeOptions,
        appendSystemPrompt:
          'Call Task exactly once. After Task succeeds, return a final answer.',
      };
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-single-delegation',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"repair","prompt":"repair and test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-duplicate-delegation',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"repeat","prompt":"repeat the repair"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'The delegated repair completed.',
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValue({
        success: true,
        llmContent: 'Subagent repaired and verified the project.',
        metadata: {
          subagentStatus: 'completed',
          verificationCommands: ['npm test'],
        },
      });

      const { events, result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Delegate this repair to channel-specialist with the Task tool.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(
        events.some(
          (event) =>
            event.kind === 'tool_result' &&
            'function' in event.toolCall &&
            event.toolCall.id === 'tc-duplicate-delegation' &&
            event.result.error?.type === 'validation_error'
        )
      ).toBe(true);
    });

    it('restores an unfinished successful exactly-once Task from durable history', async () => {
      const deps = createMockDeps();
      deps.runtimeOptions = {
        ...deps.runtimeOptions,
        appendSystemPrompt: 'Call Task exactly once before returning an answer.',
      };
      const context = createMockContext({
        messages: [
          {
            role: 'user',
            content: 'Delegate the repair.',
          },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'durable-task-call',
                type: 'function',
                function: {
                  name: 'Task',
                  arguments: '{"subagent_type":"channel-specialist"}',
                },
              },
            ],
          },
          {
            role: 'tool',
            name: 'Task',
            tool_call_id: 'durable-task-call',
            content: 'Subagent repaired the project.',
            metadata: {
              toolCallId: 'durable-task-call',
              toolName: 'Task',
              error: null,
            },
          },
        ],
      });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: 'The previously delegated repair completed.',
        finishReason: 'stop',
      });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Continue after the restored delegation and return the final answer.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).not.toHaveBeenCalled();
      expect(chatMock).toHaveBeenCalledWith(
        expect.any(Array),
        expect.not.arrayContaining([expect.objectContaining({ name: 'Task' })]),
        undefined
      );
    });

    it('allows an exactly-once Task delegation to retry after a failed attempt', async () => {
      const deps = createMockDeps();
      deps.runtimeOptions = {
        ...deps.runtimeOptions,
        appendSystemPrompt: 'Call Task exactly once after it succeeds.',
      };
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-failed-delegation',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"repair","prompt":"repair and test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-retried-delegation',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"channel-specialist","description":"retry","prompt":"retry the repair"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'The delegated repair completed.',
          finishReason: 'stop',
        });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock
        .mockResolvedValueOnce({
          success: false,
          llmContent: 'Subagent failed.',
          error: { type: 'execution_error', message: 'Subagent failed' },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'Subagent repaired the project.',
        });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Delegate this repair with the Task tool.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledTimes(2);
    });

    it('preserves repeated Task calls when no exactly-once contract exists', async () => {
      const deps = createMockDeps();
      deps.runtimeOptions = {
        ...deps.runtimeOptions,
        appendSystemPrompt: 'Use the Task tool if a specialist is needed.',
      };
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-first-parallel-task',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"reviewer","description":"review one","prompt":"review the first area"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-second-parallel-task',
              type: 'function',
              function: {
                name: 'Task',
                arguments:
                  '{"subagent_type":"reviewer","description":"review two","prompt":"review the second area"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Both reviews completed.',
          finishReason: 'stop',
        });
      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValue({
        success: true,
        llmContent: 'Review completed.',
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Review both areas exactly once.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock).toHaveBeenCalledTimes(2);
    });

    it('propagates a worktree workspace transition to later tool calls', async () => {
      const deps = createMockDeps();
      const context = createMockContext({ workspaceRoot: '/repo' });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-enter',
              type: 'function',
              function: {
                name: 'EnterWorktree',
                arguments: '{"name":"isolated"}',
              },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-bash',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}',
              },
            },
          ],
          usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Worktree active.',
          toolCalls: undefined,
          usage: { promptTokens: 140, completionTokens: 20, totalTokens: 160 },
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'Entered worktree',
          metadata: {
            workspaceTransition: 'enter',
            workspaceRoot: '/worktrees/isolated',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: '/worktrees/isolated',
          metadata: { command: 'pwd', exit_code: 0 },
        });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Create and use a worktree.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(context.workspaceRoot).toBe('/worktrees/isolated');
      expect(executeMock.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({ workspaceRoot: '/worktrees/isolated' })
      );
    });

    it('blocks ExitWorktree until requested verification succeeds', async () => {
      const deps = createMockDeps();
      const context = createMockContext({ workspaceRoot: '/repo' });
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-enter',
              type: 'function',
              function: {
                name: 'EnterWorktree',
                arguments: '{"name":"isolated"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-edit',
              type: 'function',
              function: {
                name: 'Edit',
                arguments:
                  '{"file_path":"/worktrees/isolated/src.ts","old_string":"bad","new_string":"good"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-exit-too-early',
              type: 'function',
              function: {
                name: 'ExitWorktree',
                arguments: '{"action":"keep"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-test',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"npm test"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-exit',
              type: 'function',
              function: {
                name: 'ExitWorktree',
                arguments: '{"action":"keep"}',
              },
            },
          ],
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Verified worktree change complete.',
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'Entered worktree',
          metadata: {
            workspaceTransition: 'enter',
            workspaceRoot: '/worktrees/isolated',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'Edited source',
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'tests passed',
          metadata: { command: 'npm test', exit_code: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: 'Exited worktree',
          metadata: {
            workspaceTransition: 'exit',
            workspaceRoot: '/repo',
          },
        });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Use a worktree to fix the bug, run npm test, then exit the worktree.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(executeMock.mock.calls.map((call) => call[0])).toEqual([
        'EnterWorktree',
        'Edit',
        'Bash',
        'ExitWorktree',
      ]);
      expect(context.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'tc-exit-too-early',
            content: expect.stringContaining('verification before ExitWorktree'),
          }),
        ])
      );
    });

    it('does not accept a failed Bash verification command', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;

      chatMock
        .mockResolvedValueOnce({
          content: 'The source change is complete.',
          toolCalls: undefined,
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-failed-test',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"npm test"}',
              },
            },
          ],
          usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Tests have been handled.',
          toolCalls: undefined,
          usage: { promptTokens: 140, completionTokens: 20, totalTokens: 160 },
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'tc-passed-test',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"npm test"}',
              },
            },
          ],
          usage: { promptTokens: 160, completionTokens: 20, totalTokens: 180 },
          finishReason: 'tool_calls',
        })
        .mockResolvedValueOnce({
          content: 'Tests now pass.',
          toolCalls: undefined,
          usage: { promptTokens: 180, completionTokens: 20, totalTokens: 200 },
          finishReason: 'stop',
        });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock
        .mockResolvedValueOnce({
          success: true,
          llmContent: '1 test failed',
          metadata: { command: 'npm test', exit_code: 1 },
        })
        .mockResolvedValueOnce({
          success: true,
          llmContent: '1 test passed',
          metadata: { command: 'npm test', exit_code: 0 },
        });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Fix the bug and run npm test before finishing.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(chatMock).toHaveBeenCalledTimes(5);
      expect(executeMock).toHaveBeenCalledTimes(2);
    });

    it('fails instead of reporting success when required verification never runs', async () => {
      const deps = createMockDeps();
      const context = createMockContext();
      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValue({
        content: 'The source change is complete.',
        toolCalls: undefined,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        finishReason: 'stop',
      });

      const { result } = await drainGenerator(
        executeLoopGenerator(
          deps,
          'Fix the bug and run npm test before finishing.',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(chatMock.mock.calls.length).toBeGreaterThan(MAX_VERIFICATION_RETRIES);
      expect(chatMock.mock.calls.length).toBeLessThanOrEqual(
        MAX_VERIFICATION_RETRIES + 2
      );
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            type: 'verification_failed',
          }),
        })
      );
    });

    it('should persist and write back the tool result before returning when tool requests loop exit', async () => {
      const { deps, saveToolResult } = createTypedPersistenceHarness();
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

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
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
        'You are a helpful assistant.'
      );

      const { result } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(saveToolResult).toHaveBeenCalledTimes(1);
      expect(saveToolResult).toHaveBeenCalledWith(
        'test-session',
        'durable-tool-id',
        'Edit',
        null,
        'durable-tool-id',
        '用户拒绝授权',
        undefined,
        undefined
      );
      expect(context.messages).toContainEqual({
        role: 'tool',
        tool_call_id: 'tc1',
        name: 'Edit',
        content: 'Error: 用户拒绝授权',
      });
    });

    it('should skip tool_result persistence when tool aborts before launch', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextManager),
        } as any,
      });
      const context = createMockContext();
      const controller = new AbortController();

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

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockImplementationOnce(async () => {
        controller.abort('user-cancel');
        return {
          success: false,
          llmContent: '任务已被用户中止',
          error: {
            type: 'execution_error',
            message: '任务已被用户中止',
          },
          metadata: {
            summary: '任务已被用户中止',
            shouldExitLoop: true,
            abortedBeforeLaunch: true,
          },
        };
      });

      const gen = executeLoopGenerator(
        deps,
        'Edit the file',
        context,
        { signal: controller.signal, stream: false } as LoopOptions,
        'You are a helpful assistant.'
      );

      const { result, events } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
      expect(events.some((event) => event.kind === 'tool_result')).toBe(false);
      expect(contextManager.saveToolResult).not.toHaveBeenCalled();
      expect(
        context.messages.some(
          (message) =>
            message.role === 'tool' &&
            'tool_call_id' in message &&
            message.tool_call_id === 'tc1'
        )
      ).toBe(false);
    });

    it('should preserve planContent when a tool exits the loop successfully', async () => {
      const deps = createMockDeps();
      const context = createMockContext();

      const chatMock = deps.chatService.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'ExitPlanMode', arguments: '{"plan":"approved"}' },
          },
        ],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        finishReason: 'tool_calls',
      });

      const executeMock = deps.toolExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValueOnce({
        success: true,
        llmContent: 'plan approved',
        metadata: {
          summary: '方案已批准，退出 Plan 模式',
          shouldExitLoop: true,
          targetMode: 'autoEdit',
          planContent: '# approved plan',
        },
      });

      const gen = executeLoopGenerator(
        deps,
        'Approve the plan',
        context,
        { stream: false } as LoopOptions,
        'You are a helpful assistant.'
      );

      const { result } = await drainGenerator(gen);

      expect(result.success).toBe(true);
      expect(result.metadata?.shouldExitLoop).toBe(true);
      expect(result.metadata?.targetMode).toBe('autoEdit');
      expect(result.metadata?.planContent).toBe('# approved plan');
    });
  });

  // ------------------------------------------------------------------
  // 4. Abort signal → returns aborted
  // ------------------------------------------------------------------
  describe('abort signal → aborted result', () => {
    it('should persist one model-visible interrupted-turn boundary', async () => {
      const contextManager = createMockContextManager();
      const deps = createMockDeps({
        executionEngine: {
          getContextManager: vi.fn().mockReturnValue(contextManager),
        } as any,
      });
      const context = createMockContext();

      const gen = executeLoopGenerator(
        deps,
        'Hello',
        context,
        { signal: AbortSignal.abort(), stream: false } as LoopOptions,
        undefined
      );

      const { result } = await drainGenerator(gen);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
      expect(result.error?.message).toContain('中止');
      expect(contextManager.saveMessage).toHaveBeenCalledTimes(2);
      expect(contextManager.saveMessage).toHaveBeenNthCalledWith(
        2,
        'test-session',
        'system',
        expect.stringContaining('<turn_aborted>'),
        'msg-user-1',
        undefined,
        undefined
      );
      expect(
        context.messages.filter(
          (entry) =>
            entry.role === 'system' &&
            typeof entry.content === 'string' &&
            entry.content.includes('<turn_aborted>')
        )
      ).toHaveLength(1);
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
        undefined
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
        executeLoopGenerator(
          deps,
          'Hi',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
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
        executeLoopGenerator(
          deps,
          'Hi',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
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
        executeLoopGenerator(
          deps,
          'Hi',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
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
        executeLoopGenerator(
          deps,
          'Fix the bug',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      // context.messages 应包含 turn 1 的 assistant 消息
      const assistantMessages = context.messages.filter(
        (m: { role: string }) => m.role === 'assistant'
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      // 第一�� assistant 消息是 incomplete-intent 那轮的输出
      expect(assistantMessages[0].content).toBe('让我先查看一下文件');

      // 关键顺序断言：assistant 消息必须紧挨在 retry 控制消息之前
      const allMessages = context.messages;
      const firstAssistantIdx = allMessages.findIndex(
        (m: { role: string; content: unknown }) =>
          m.role === 'assistant' && m.content === '让我先查看一下文件'
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
        executeLoopGenerator(
          deps,
          'Do the work',
          context,
          { stream: false } as LoopOptions,
          undefined
        )
      );

      expect(result.success).toBe(true);
      // context.messages 应包含 turn 1 的 assistant 消息
      const assistantMessages = context.messages.filter(
        (m: { role: string }) => m.role === 'assistant'
      );
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      expect(assistantMessages[0].content).toBe('First part of work');

      // 关键顺序断言：assistant 消息必须紧挨在 continue 控制消息之前
      const allMessages = context.messages;
      const firstAssistantIdx = allMessages.findIndex(
        (m: { role: string; content: unknown }) =>
          m.role === 'assistant' && m.content === 'First part of work'
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
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          })
        )
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
          content:
            '请执行你提到的操作，不要只是描述。使用 Edit/Write/Bash 工具来实际修改文件。',
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
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          })
        )
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
          undefined
        )
      );

      expect(result.success).toBe(true);
      expect(contextMgr.saveMessage.mock.calls).toHaveLength(4);
      expect(
        contextMgr.saveMessage.mock.calls.map(
          ([sessionId, role, content, parentUuid]) => ({
            sessionId,
            role,
            content,
            parentUuid,
          })
        )
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
