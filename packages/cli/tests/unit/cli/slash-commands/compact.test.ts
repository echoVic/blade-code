import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompactionOptions,
  CompactionResult,
} from '../../../../src/context/CompactionService.js';
import type { CompactionPersistenceMetadata } from '../../../../src/context/compactionCheckpoint.js';
import {
  isTokenBudgetHandoffMessage,
  projectTokenBudgetHandoffEvent,
} from '../../../../src/context/TokenBudgetHandoff.js';
import type {
  ContextManagerOptions,
  TokenBudgetHandoffRecordedEvent,
} from '../../../../src/context/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

type SaveCompaction = (
  sessionId: string,
  summary: string,
  metadata: CompactionPersistenceMetadata,
  parentUuid: string | null
) => Promise<string>;
type Compact = (
  messages: Message[],
  options: CompactionOptions
) => Promise<CompactionResult>;

const contextManagerState = vi.hoisted(
  (): {
    constructorOptions: Array<Partial<ContextManagerOptions> | undefined>;
    saveCompaction: ReturnType<typeof vi.fn<SaveCompaction>>;
  } => ({
    constructorOptions: [],
    saveCompaction: vi.fn(),
  })
);

const compactionState = vi.hoisted(
  (): {
    compact: ReturnType<typeof vi.fn<Compact>>;
  } => ({
    compact: vi.fn<Compact>(),
  })
);

const storeState = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getCurrentModel: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('../../../../src/context/ContextManager.js', () => ({
  ContextManager: class {
    constructor(options?: Partial<ContextManagerOptions>) {
      contextManagerState.constructorOptions.push(options);
    }

    saveCompaction(
      sessionId: string,
      summary: string,
      metadata: CompactionPersistenceMetadata,
      parentUuid: string | null
    ): Promise<string> {
      return contextManagerState.saveCompaction(
        sessionId,
        summary,
        metadata,
        parentUuid
      );
    }
  },
}));

vi.mock('../../../../src/context/CompactionService.js', () => ({
  CompactionService: { compact: compactionState.compact },
}));

vi.mock('../../../../src/context/TokenCounter.js', () => ({
  TokenCounter: { countTokens: () => 600_000 },
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  getConfig: storeState.getConfig,
  getCurrentModel: storeState.getCurrentModel,
  getState: storeState.getState,
  sessionActions: () => ({ addAssistantMessage: vi.fn() }),
}));

function projectedHandoff(): Message {
  const event = {
    id: 'manual-handoff-event',
    sessionId: 'shared-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/workspace/managed-worktree',
    version: 'test',
    data: {
      version: 1,
      messageId: 'manual-handoff-message',
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

describe('/compact slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextManagerState.constructorOptions.length = 0;
    contextManagerState.saveCompaction.mockResolvedValue('summary-id');
    storeState.getConfig.mockReturnValue({
      maxContextTokens: 10_000,
      temperature: 0,
      timeout: 30_000,
    });
    storeState.getCurrentModel.mockReturnValue({
      id: 'test-model',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      overrides: { baseUrl: 'https://example.invalid' },
    });
    storeState.getState.mockReturnValue({
      session: {
        sessionId: 'stale-store-session',
        messages: [{ role: 'user', content: 'STALE_STORE_HISTORY' }],
      },
    });
    compactionState.compact.mockResolvedValue({
      success: true,
      summary: 'summary',
      preTokens: 600_000,
      postTokens: 1_000,
      filesIncluded: [],
      compactedMessages: [{ role: 'user', content: 'summary' }],
      boundaryMessage: { role: 'system', content: 'boundary' },
      summaryMessage: { role: 'user', content: 'summary' },
      sampleAttempts: 1,
      inputReductions: 0,
      messagesOmitted: 0,
      filesOmitted: 0,
      imagesOmitted: 2,
    });
  });

  it('persists manual compaction in the active workspace transcript', async () => {
    const { default: compactCommand } = await import(
      '../../../../src/slash-commands/compact.js'
    );
    const context: SlashCommandContext = {
      cwd: '/workspace/original',
      workspaceRoot: '/workspace/managed-worktree',
      sessionId: 'shared-session',
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'inspect the owned file',
          tool_calls: [
            {
              id: 'owned-read',
              type: 'function',
              function: {
                name: 'Read',
                arguments: '{"file_path":"src/owned.ts"}',
              },
            },
          ],
          metadata: { owner: 'acp' },
        },
        {
          role: 'tool',
          content: 'ACP_OWNED_HISTORY',
          tool_call_id: 'owned-read',
          name: 'Read',
        },
      ],
      acp: { sendMessage: vi.fn() },
    };

    await expect(compactCommand.handler([], context)).resolves.toMatchObject({
      success: true,
      message: 'compact_completed',
      data: {
        sampleAttempts: 1,
        inputReductions: 0,
        messagesOmitted: 0,
        filesOmitted: 0,
        imagesOmitted: 2,
      },
    });

    expect(compactionState.compact).toHaveBeenCalledWith(
      context.messages,
      expect.objectContaining({
        workspaceRoot: '/workspace/managed-worktree',
        sessionId: 'shared-session',
      })
    );
    expect(contextManagerState.constructorOptions).toEqual([
      { projectPath: '/workspace/managed-worktree' },
    ]);
    expect(contextManagerState.saveCompaction).toHaveBeenCalledWith(
      'shared-session',
      'summary',
      expect.objectContaining({
        trigger: 'manual',
        reason: 'manual',
        strategy: 'llm',
        replacementMessages: [{ role: 'user', content: 'summary' }],
      }),
      null
    );
  });

  it('保留缩减不足 fallback 的 usage 与稳定分类', async () => {
    const { default: compactCommand } = await import(
      '../../../../src/slash-commands/compact.js'
    );
    const usage = {
      promptTokens: 7_000,
      completionTokens: 9_000,
      totalTokens: 16_000,
      costUsd: 0.25,
    };
    compactionState.compact.mockResolvedValueOnce({
      success: false,
      summary: 'bounded fallback',
      preTokens: 60_000,
      postTokens: 12_000,
      filesIncluded: [],
      compactedMessages: [{ role: 'user', content: 'bounded fallback' }],
      boundaryMessage: { role: 'system', content: 'boundary' },
      summaryMessage: { role: 'user', content: 'bounded fallback' },
      error: 'Compaction output retained too many tokens',
      usage,
      sampleAttempts: 1,
      inputReductions: 0,
      messagesOmitted: 0,
      filesOmitted: 0,
      imagesOmitted: 0,
      fallbackTargetTokens: 64_000,
      fallbackMessagesOmitted: 8,
      fallbackMessagesTruncated: 1,
      failureReason: 'insufficient_reduction',
    });
    const sendMessage = vi.fn();

    const result = await compactCommand.handler([], {
      cwd: '/workspace/original',
      workspaceRoot: '/workspace/managed-worktree',
      sessionId: 'shared-session',
      messages: [{ role: 'user', content: 'compact this history' }],
      acp: { sendMessage },
    });

    expect(result).toMatchObject({
      success: false,
      message: 'compact_fallback',
      data: {
        usage,
        maxContextTokens: expect.any(Number),
        fallbackTargetTokens: 64_000,
        fallbackMessagesOmitted: 8,
        fallbackMessagesTruncated: 1,
        failureReason: 'insufficient_reduction',
      },
    });
    expect((result.data?.maxContextTokens as number | undefined) ?? 0).toBeGreaterThan(
      0
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('失败分类: insufficient_reduction')
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('降级 token 目标: 64,000 tokens')
    );
    expect(contextManagerState.saveCompaction).toHaveBeenCalledWith(
      'shared-session',
      'bounded fallback',
      expect.objectContaining({
        strategy: 'fallback',
        fallbackTargetTokens: 64_000,
        fallbackMessagesOmitted: 8,
        fallbackMessagesTruncated: 1,
        failureReason: 'insufficient_reduction',
      }),
      null
    );
  });

  it('原样持久化 CompactionService boundary 返回的无 marker replacement', async () => {
    const { default: compactCommand } = await import(
      '../../../../src/slash-commands/compact.js'
    );
    const marker = projectedHandoff();
    const sourceMessages: Message[] = [
      { role: 'user', content: 'before' },
      marker,
      { role: 'assistant', content: 'after' },
    ];
    const boundaryReplacement: Message[] = [
      { role: 'user', content: 'ledger summary' },
      { role: 'assistant', content: 'after' },
    ];
    compactionState.compact.mockResolvedValueOnce({
      success: true,
      summary: 'ledger summary',
      preTokens: 600_000,
      postTokens: 1_000,
      filesIncluded: [],
      compactedMessages: boundaryReplacement,
      boundaryMessage: { role: 'system', content: 'boundary' },
      summaryMessage: { role: 'user', content: 'ledger summary' },
    });
    const context: SlashCommandContext = {
      cwd: '/workspace/original',
      workspaceRoot: '/workspace/managed-worktree',
      sessionId: 'shared-session',
      messages: sourceMessages,
      acp: { sendMessage: vi.fn() },
    };

    await expect(compactCommand.handler([], context)).resolves.toMatchObject({
      success: true,
      message: 'compact_completed',
    });

    expect(sourceMessages.some(isTokenBudgetHandoffMessage)).toBe(true);
    expect(compactionState.compact).toHaveBeenCalledWith(
      sourceMessages,
      expect.any(Object)
    );
    const persistedMetadata = contextManagerState.saveCompaction.mock.calls.at(-1)?.[2];
    expect(persistedMetadata?.replacementMessages).toBe(boundaryReplacement);
    expect(
      persistedMetadata?.replacementMessages?.some(isTokenBudgetHandoffMessage)
    ).toBe(false);
  });

  it('boundary 阻止压缩时不持久化 checkpoint 并保留原 marker', async () => {
    const { default: compactCommand } = await import(
      '../../../../src/slash-commands/compact.js'
    );
    const marker = projectedHandoff();
    const sourceMessages: Message[] = [
      { role: 'user', content: 'before' },
      marker,
      { role: 'assistant', content: 'after' },
    ];
    compactionState.compact.mockRejectedValueOnce(
      new Error('policy denied compaction')
    );
    const context: SlashCommandContext = {
      cwd: '/workspace/original',
      workspaceRoot: '/workspace/managed-worktree',
      sessionId: 'shared-session',
      messages: sourceMessages,
      acp: { sendMessage: vi.fn() },
    };

    await expect(compactCommand.handler([], context)).resolves.toMatchObject({
      success: false,
      error: 'policy denied compaction',
    });

    expect(contextManagerState.saveCompaction).not.toHaveBeenCalled();
    expect(sourceMessages.some(isTokenBudgetHandoffMessage)).toBe(true);
  });
});
