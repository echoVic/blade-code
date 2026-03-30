import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompactionService } from '../../../../src/context/CompactionService.js';
import { checkAndCompactInLoop } from '../../../../src/agent/loopCompaction.js';
import type { BladeConfig } from '../../../../src/config/index.js';
import type { ChatContext } from '../../../../src/agent/types.js';
import type { IChatService, Message } from '../../../../src/services/ChatServiceInterface.js';

describe('loopCompaction', () => {
  const baseMessages: Message[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ];

  let context: ChatContext;
  let chatService: Pick<IChatService, 'getConfig'>;
  let executionEngine: {
    getContextManager: () => {
      saveCompaction: ReturnType<typeof vi.fn>;
    };
  };
  let saveCompaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    context = {
      messages: [...baseMessages],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };
    chatService = {
      getConfig: () => ({
        provider: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'test-model',
        maxContextTokens: 10000,
        maxOutputTokens: 2000,
      }),
    };
    saveCompaction = vi.fn().mockResolvedValue(undefined);
    executionEngine = {
      getContextManager: () => ({
        saveCompaction,
      }),
    };
  });

  it('returns false without compacting when prompt token usage is unavailable', async () => {
    const compactSpy = vi.spyOn(CompactionService, 'compact');

    const didCompact = await checkAndCompactInLoop({
      context,
      currentTurn: 0,
      actualPromptTokens: undefined,
      chatService,
      config: {
        maxContextTokens: 16000,
        maxOutputTokens: 4000,
      } as BladeConfig,
      executionEngine,
    });

    expect(didCompact).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it('returns false when prompt tokens stay below the compaction threshold', async () => {
    const compactSpy = vi.spyOn(CompactionService, 'compact');

    const didCompact = await checkAndCompactInLoop({
      context,
      currentTurn: 2,
      actualPromptTokens: 6399,
      chatService,
      config: {
        maxContextTokens: 16000,
        maxOutputTokens: 4000,
      } as BladeConfig,
      executionEngine,
    });

    expect(didCompact).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it('updates context, notifies compaction state, and persists compaction metadata', async () => {
    const onCompacting = vi.fn();
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];

    vi.spyOn(CompactionService, 'compact').mockResolvedValue({
      success: true,
      summary: 'compacted summary',
      preTokens: 7000,
      postTokens: 1200,
      filesIncluded: ['src/agent/Agent.ts'],
      compactedMessages,
      boundaryMessage: { role: 'system', content: 'boundary' },
      summaryMessage: { role: 'assistant', content: 'summary' },
    });

    const didCompact = await checkAndCompactInLoop({
      context,
      currentTurn: 3,
      actualPromptTokens: 7000,
      onCompacting,
      chatService,
      config: {
        maxContextTokens: 16000,
        maxOutputTokens: 4000,
      } as BladeConfig,
      executionEngine,
    });

    expect(didCompact).toBe(true);
    expect(context.messages).toEqual(compactedMessages);
    expect(onCompacting).toHaveBeenNthCalledWith(1, true);
    expect(onCompacting).toHaveBeenNthCalledWith(2, false);
    expect(saveCompaction).toHaveBeenCalledWith(
      'session-1',
      'compacted summary',
      {
        trigger: 'auto',
        preTokens: 7000,
        postTokens: 1200,
        filesIncluded: ['src/agent/Agent.ts'],
      },
      null
    );
  });
});
