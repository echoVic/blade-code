import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

vi.mock('../../../../src/context/CompactionService.js');
vi.mock('../../../../src/context/SnipCompaction.js');

import { ReactiveCompaction } from '../../../../src/context/ReactiveCompaction.js';
import { CompactionService } from '../../../../src/context/CompactionService.js';
import { snipCompact } from '../../../../src/context/SnipCompaction.js';

const mockedSnipCompact = vi.mocked(snipCompact);
const mockedCompact = vi.mocked(CompactionService.compact);

const defaultOptions = {
  modelName: 'gpt-4o',
  maxContextTokens: 128000,
  apiKey: 'test-key',
  baseURL: 'https://api.example.com/v1',
};

function makeMessages(count: number, prefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `${prefix}-${i}`,
  }));
}

describe('ReactiveCompaction', () => {
  let rc: ReactiveCompaction;
  let originalMsgs: Message[];
  let snippedMsgs: Message[];
  let compactedMsgs: Message[];

  beforeEach(() => {
    vi.clearAllMocks();
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
    mockedCompact.mockResolvedValue({
      success: true,
      compactedMessages: compactedMsgs,
    } as any);

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toEqual({ success: true, messages: compactedMsgs });
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
    });
  });

  it('returns false immediately on second call without reset', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 2,
      estimatedTokensFreed: 500,
    });
    mockedCompact.mockResolvedValue({
      success: true,
      compactedMessages: compactedMsgs,
    } as any);

    await rc.tryReactiveCompact(originalMsgs, defaultOptions);

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
    mockedCompact.mockResolvedValue({
      success: true,
      compactedMessages: compactedMsgs,
    } as any);

    const firstResult = await rc.tryReactiveCompact(originalMsgs, defaultOptions);
    expect(firstResult.success).toBe(true);

    rc.reset();

    const secondResult = await rc.tryReactiveCompact(originalMsgs, defaultOptions);
    expect(secondResult).toEqual({ success: true, messages: compactedMsgs });
    expect(mockedSnipCompact).toHaveBeenCalledTimes(2);
    expect(mockedCompact).toHaveBeenCalledTimes(2);
  });

  it('falls back to snipped messages when compact fails but snip had effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 3,
      estimatedTokensFreed: 800,
    });
    mockedCompact.mockResolvedValue({
      success: false,
      compactedMessages: [],
    } as any);

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toEqual({ success: true, messages: snippedMsgs });
  });

  it('falls back to snipped messages when compact throws but snip had effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: snippedMsgs,
      snippedCount: 1,
      estimatedTokensFreed: 200,
    });
    mockedCompact.mockRejectedValue(new Error('LLM request failed'));

    const result = await rc.tryReactiveCompact(originalMsgs, defaultOptions);

    expect(result).toEqual({ success: true, messages: snippedMsgs });
  });

  it('returns false when compact fails and snip had no effect', async () => {
    mockedSnipCompact.mockReturnValue({
      messages: originalMsgs,
      snippedCount: 0,
      estimatedTokensFreed: 0,
    });
    mockedCompact.mockResolvedValue({
      success: false,
      compactedMessages: [],
    } as any);

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
