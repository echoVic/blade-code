import { describe, expect, it } from 'vitest';
import type { UserPromptArtifactStore } from '../../../../../src/agent/runtime/UserPromptArtifactStore.js';
import type { SessionBrowserRuntime } from '../../../../../src/browser/SessionBrowserRuntime.js';
import type { LspSessionManager } from '../../../../../src/lsp/LspSessionManager.js';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';

describe('builtin tool sampling policy', () => {
  it('keeps builtin tools on host-validated non-strict sampling', async () => {
    const tools = await getBuiltinTools({
      sessionId: 'sampling-policy-inventory',
      workspaceRoot: '/workspace',
      configDir: '/tmp/blade-sampling-policy-inventory',
      agentTeamsEnabled: true,
      browserRuntime: {} as SessionBrowserRuntime,
      lspManager: { available: true } as LspSessionManager,
      userPromptArtifactStore: {} as UserPromptArtifactStore,
    });

    expect(tools.length).toBeGreaterThan(0);
    expect(
      tools
        .filter(
          (tool) => tool.getFunctionDeclaration().constrainedSampling !== undefined
        )
        .map((tool) => tool.name)
    ).toEqual([]);
  });
});
