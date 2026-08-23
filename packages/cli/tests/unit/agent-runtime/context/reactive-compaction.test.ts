import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

vi.mock('../../../../src/context/CompactionService.js');
vi.mock('../../../../src/context/SnipCompaction.js');

import {
  type CompactionResult,
  CompactionService,
  isCompactionBlockedError,
} from '../../../../src/context/CompactionService.js';
import { ReactiveCompaction } from '../../../../src/context/ReactiveCompaction.js';
import { snipCompact } from '../../../../src/context/SnipCompaction.js';
import {
  isTokenBudgetHandoffMessage,
  projectTokenBudgetHandoffEvent,
} from '../../../../src/context/TokenBudgetHandoff.js';
import type { TokenBudgetHandoffRecordedEvent } from '../../../../src/context/types.js';

const mockedSnipCompact = vi.mocked(snipCompact);
const mockedCompact = vi.mocked(CompactionService.compact);
const mockedIsCompactionBlockedError = vi.mocked(isCompactionBlockedError);

const defaultOptions = {
  modelName: 'gpt-4o',
  maxContextTokens: 128000,
  apiKey: 'test-key',
  baseURL: 'https://api.example.com/v1',
  workspaceRoot: '/tmp/active-worktree',
  sessionId: 'active-session',
};

function makeMessages(count: number, prefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `${prefix}-${i}`,
  }));
}

function compactionResult(fixture: CompactionResult): CompactionResult {
  return fixture;
}

function projectedHandoff(): Message {
  const event = {
    id: 'reactive-handoff-event',
    sessionId: 'active-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/tmp/active-worktree',
    version: 'test',
    data: {
      version: 1,
      messageId: 'reactive-handoff-message',
      observedPromptTokens: 70_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  } satisfies TokenBudgetHandoffRecordedEvent;
  const marker = projectTokenBudgetHandoffEvent(event);
  if (!marker) {
    throw new Error('Expected a valid token-budget handoff marker fixture');
  }
  return marker;
}

describe('ReactiveCompaction', () => {
  let rc: ReactiveCompaction;
  let originalMsgs: Message[];
  let snippedMsgs: Message[];
  let compactedMsgs: Message[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsCompactionBlockedError.mockImplementation(
      (error) => error instanceof Error && error.name === 'CompactionBlockedError'
    );
    rc = new ReactiveCompaction();
    originalMsgs = makeMessages(12, 'original');
    snippedMsgs = makeMessages(8, 'snipped');
    compactedMsgs = makeMessages(3, 'compacted');
  });

  it('returns compacted messages when both snip and compact succeed', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 2,
      estimatedTokensFreed: 500,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: true,
        summary: 'durable summary',
        preTokens: 96,
        postTokens: 24,
        filesIncluded: [],
        compactedMessages: compactedMsgs,
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: 'durable summary' },
      } satisfies CompactionResult)
    );

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toMatchObject({
      success: true,
      messages: compactedMsgs,
      strategy: 'llm',
      summary: 'durable summary',
      preTokens: 96,
      postTokens: 24,
    });
    expect(mockedSnipCompact).toHaveBeenCalledWith(originalMsgs, {
      keepRecentTurns: 3,
      minMessagesForSnip: 10,
    });
    expect(mockedCompact).toHaveBeenCalledWith(snippedMsgs, {
      trigger: 'auto',
      modelName: defaultOptions.modelName,
      maxContextTokens: defaultOptions.maxContextTokens,
      apiKey: defaultOptions.apiKey,
      baseURL: defaultOptions.baseURL,
      workspaceRoot: defaultOptions.workspaceRoot,
      sessionId: defaultOptions.sessionId,
    });
  });

  it('returns false immediately on second call without reset', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 2,
      estimatedTokensFreed: 500,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: true,
        summary: 'durable summary',
        preTokens: 96,
        postTokens: 24,
        filesIncluded: [],
        compactedMessages: compactedMsgs,
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: 'durable summary' },
      } satisfies CompactionResult)
    );

    await rc.tryReactiveCompact(originalMsgs, defaultOptions);
    expect(rc.canAttempt()).toBe(false);

    const secondResult = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(secondResult).toEqual({ success: false, messages: originalMsgs });
    expect(mockedSnipCompact).toHaveBeenCalledTimes(1);
    expect(mockedCompact).toHaveBeenCalledTimes(1);
  });

  it('allows a second call after reset()', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 2,
      estimatedTokensFreed: 500,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: true,
        summary: 'durable summary',
        preTokens: 96,
        postTokens: 24,
        filesIncluded: [],
        compactedMessages: compactedMsgs,
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: 'durable summary' },
      } satisfies CompactionResult)
    );

    const firstResult = await rc.tryReactiveCompact(originalMsgs, defaultOptions);
    expect(firstResult.success).toBe(true);

    rc.reset();
    expect(rc.canAttempt()).toBe(true);

    const secondResult = await rc.tryReactiveCompact(originalMsgs, defaultOptions);
    expect(secondResult).toMatchObject({
      success: true,
      messages: compactedMsgs,
      strategy: 'llm',
    });
    expect(mockedSnipCompact).toHaveBeenCalledTimes(2);
    expect(mockedCompact).toHaveBeenCalledTimes(2);
  });

  it('falls back to snipped messages when compact fails but snip had effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 3,
      estimatedTokensFreed: 800,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: false,
        summary: '',
        preTokens: 96,
        postTokens: 96,
        filesIncluded: [],
        compactedMessages: [],
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: '' },
      } satisfies CompactionResult)
    );

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toMatchObject({
      success: true,
      messages: snippedMsgs,
      strategy: 'snip',
      preTokens: expect.any(Number),
      postTokens: expect.any(Number),
    });
  });

  it('uses the deterministic CompactionService fallback as a durable checkpoint', async () => {
    const fallbackMessages = makeMessages(2, 'fallback');
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 3,
      estimatedTokensFreed: 800,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: false,
        summary: 'fallback checkpoint',
        preTokens: 96,
        postTokens: 16,
        filesIncluded: [],
        compactedMessages: fallbackMessages,
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: 'fallback checkpoint' },
        fallbackTargetTokens: 64,
        fallbackMessagesOmitted: 4,
        fallbackMessagesTruncated: 1,
      } satisfies CompactionResult)
    );

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toMatchObject({
      success: true,
      messages: fallbackMessages,
      strategy: 'fallback',
      summary: 'fallback checkpoint',
      preTokens: 96,
      postTokens: 16,
      fallbackTargetTokens: 64,
      fallbackMessagesOmitted: 4,
      fallbackMessagesTruncated: 1,
    });
  });

  it('snip-only recovery 的输入与返回结果都应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const messages: Message[] = [
      ...makeMessages(6, 'before'),
      marker,
      ...makeMessages(6, 'after'),
    ];
    mockedSnipCompact.mockImplementation((input) => ({
      messages: [...input],
      snippedCount: 1,
      estimatedTokensFreed: 1,
    }));
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: false,
        summary: '',
        preTokens: 128,
        postTokens: 128,
        filesIncluded: [],
        compactedMessages: [],
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: '' },
      } satisfies CompactionResult)
    );

    const result = await rc.tryReactiveCompact(messages, defaultOptions);
    const snipInput = mockedSnipCompact.mock.calls.at(-1)?.[0];
    const compactInput = mockedCompact.mock.calls.at(-1)?.[0];

    expect(snipInput?.some(isTokenBudgetHandoffMessage)).toBe(false);
    expect(compactInput?.some(isTokenBudgetHandoffMessage)).toBe(false);
    expect(result.messages.some(isTokenBudgetHandoffMessage)).toBe(false);
  });

  it('falls back to snipped messages when compact throws but snip had effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 1,
      estimatedTokensFreed: 200,
    });
    mockedCompact.mockRejectedValue(new Error('LLM request failed'));

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toMatchObject({
      success: true,
      messages: snippedMsgs,
      strategy: 'snip',
    });
  });

  it('preserves the original marker when a hook blocks reactive compaction', async () => {
    const marker = projectedHandoff();
    const messages: Message[] = [
      ...makeMessages(6, 'before'),
      marker,
      ...makeMessages(6, 'after'),
    ];
    mockedSnipCompact.mockImplementation((input) => ({
      messages: input.filter((message) => message !== input[0]),
      snippedCount: 1,
      estimatedTokensFreed: 100,
    }));
    const blockedError = new Error('policy denied compaction');
    blockedError.name = 'CompactionBlockedError';
    mockedCompact.mockRejectedValueOnce(blockedError);

    const result = await rc.tryReactiveCompact(messages, defaultOptions);

    expect(result).toEqual({ success: false, messages });
    expect(result.messages.some(isTokenBudgetHandoffMessage)).toBe(true);
  });

  it('returns false when compact fails and snip had no effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: originalMsgs,
      snippedCount: 0,
      estimatedTokensFreed: 0,
    });
    mockedCompact.mockResolvedValue(
      compactionResult({
        success: false,
        summary: '',
        preTokens: 96,
        postTokens: 96,
        filesIncluded: [],
        compactedMessages: [],
        boundaryMessage: { role: 'system', content: 'Conversation compacted' },
        summaryMessage: { role: 'user', content: '' },
      } satisfies CompactionResult)
    );

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toEqual({ success: false, messages: originalMsgs });
  });

  it('returns false when compact throws and snip had no effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: originalMsgs,
      snippedCount: 0,
      estimatedTokensFreed: 0,
    });
    mockedCompact.mockRejectedValue(new Error('network error'));

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toEqual({ success: false, messages: originalMsgs });
  });
});
