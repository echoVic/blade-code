import { describe, expect, it, vi } from 'vitest';
import { checkAndCompactInLoop } from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies } from '../../../../src/agent/loop/types.js';
import type { ChatContext } from '../../../../src/agent/types.js';
import { type BladeConfig, PermissionMode } from '../../../../src/config/types.js';
import { CompactionService } from '../../../../src/context/CompactionService.js';
import { deriveTokenBudgetSnapshot } from '../../../../src/context/TokenBudgetHandoff.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';

function createConfig(overrides: Partial<BladeConfig> = {}): BladeConfig {
  return {
    currentModelId: '',
    models: [],
    temperature: 0,
    maxContextTokens: 200000,
    stream: true,
    topP: 0.9,
    topK: 50,
    timeout: 30000,
    codeTheme: 'dracula',
    uiTheme: 'system',
    language: 'zh-CN',
    fontSize: 14,
    autoSaveSessions: true,
    notifyBuild: false,
    notifyErrors: false,
    notifySounds: false,
    privacyTelemetry: false,
    privacyCrash: true,
    debug: false,
    mcpEnabled: false,
    mcpServers: {},
    permissions: {
      allow: [],
      ask: [],
      deny: [],
    },
    permissionMode: PermissionMode.DEFAULT,
    hooks: {} as BladeConfig['hooks'],
    env: {},
    disableAllHooks: false,
    maxTurns: 20,
    ...overrides,
    lspServers: overrides.lspServers ?? {},
    modelProviders: overrides.modelProviders ?? {},
    enabledPlugins: overrides.enabledPlugins ?? {},
    pluginSourcePolicy: overrides.pluginSourcePolicy ?? {
      restrictToAllowedSources: false,
      requireGitCommitSha: false,
      allowedGitHosts: [],
      allowedMarketplaces: [],
      allowedLocalRoots: [],
    },
    maxConcurrentTasks: overrides.maxConcurrentTasks ?? 3,
    maxQueuedTasks: overrides.maxQueuedTasks ?? 100,
    maxQueuedTaskBytes: overrides.maxQueuedTaskBytes ?? 64 * 1024 * 1024,
    maxResidentSessionRuntimes: overrides.maxResidentSessionRuntimes ?? 32,
    sessionRuntimeIdleMs: overrides.sessionRuntimeIdleMs ?? 5 * 60 * 1000,
  };
}

function createContext(): ChatContext {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    userId: 'user-1',
    sessionId: 'session-1',
    workspaceRoot: process.cwd(),
    permissionMode: PermissionMode.DEFAULT,
  };
}

function createDeps(): LoopDependencies {
  const toolExecutor = new ToolExecutor(new ToolRegistry());
  return {
    chatService: {
      chat: async () => {
        throw new Error('not used');
      },
      streamChat: async function* () {
        yield* [];
      },
      getConfig: () => ({
        provider: 'openai',
        model: 'test-model',
        maxContextTokens: 200000,
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      }),
      updateConfig: () => undefined,
    },
    toolExecutor,
    executionEngine: undefined,
    config: createConfig(),
    runtimeOptions: {},
    currentModelMaxContextTokens: 200000,
    applySkillToolRestrictions: (tools) => tools,
  };
}

describe('Agent compaction threshold fallback', () => {
  it('uses a larger dynamic fallback output budget when maxOutputTokens is not configured', async () => {
    const compactSpy = vi.spyOn(CompactionService, 'compact').mockResolvedValue({
      success: true,
      summary: 'summary',
      preTokens: 148000,
      postTokens: 24000,
      filesIncluded: [],
      compactedMessages: [{ role: 'system', content: 'summary' }],
      boundaryMessage: { role: 'system', content: '' },
      summaryMessage: { role: 'user', content: 'summary' },
    });

    const deps = createDeps();
    const snapshot = deriveTokenBudgetSnapshot({
      actualPromptTokens: 148000,
      maxContextTokens: 200000,
      maxOutputTokens: 20000,
    });
    const compaction = checkAndCompactInLoop(deps, createContext(), 2, snapshot);
    let next = await compaction.next();
    while (!next.done) {
      next = await compaction.next();
    }
    const didCompact = next.value;

    expect(didCompact).toEqual({ kind: 'compacted', postTokens: 24000 });
    expect(compactSpy).toHaveBeenCalledOnce();
  });
});
