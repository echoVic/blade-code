import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextManagerOptions } from '../../../../src/context/types.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

const contextManagerState = vi.hoisted(
  (): {
    constructorOptions: Array<Partial<ContextManagerOptions> | undefined>;
    saveCompaction: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
  } => ({
    constructorOptions: [],
    saveCompaction: vi.fn(),
  })
);

const compactionState = vi.hoisted(() => ({
  compact: vi.fn(),
}));

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
      metadata: Record<string, unknown>,
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
      expect.objectContaining({ trigger: 'manual' }),
      null
    );
  });
});
