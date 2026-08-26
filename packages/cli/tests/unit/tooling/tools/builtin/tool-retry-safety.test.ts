import { describe, expect, it } from 'vitest';
import type { UserPromptArtifactStore } from '../../../../../src/agent/runtime/UserPromptArtifactStore.js';
import type { SessionBrowserRuntime } from '../../../../../src/browser/SessionBrowserRuntime.js';
import type { LspSessionManager } from '../../../../../src/lsp/LspSessionManager.js';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';

describe('builtin tool retry safety', () => {
  it('only opts audited idempotent query tools into transient retries', async () => {
    const tools = await getBuiltinTools({
      sessionId: 'retry-safety-inventory',
      workspaceRoot: '/workspace',
      configDir: '/tmp/blade-retry-safety-inventory',
      agentTeamsEnabled: true,
      browserRuntime: {} as SessionBrowserRuntime,
      lspManager: { available: true } as LspSessionManager,
      userPromptArtifactStore: {} as UserPromptArtifactStore,
    });

    expect(
      tools
        .filter((tool) => tool.isRetrySafe)
        .map((tool) => tool.name)
        .sort()
    ).toEqual(
      [
        'GetGoal',
        'Glob',
        'Grep',
        'LSP',
        'MemoryRead',
        'Read',
        'ReadPromptArtifact',
        'TaskGet',
        'TaskList',
        'TeamStatus',
        'ToolSearch',
      ].sort()
    );
  });
});
