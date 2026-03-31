import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
import type { ChatContext } from '../../../../src/agent/types.js';
import { type BladeConfig, PermissionMode } from '../../../../src/config/types.js';
import { CompactionService } from '../../../../src/context/CompactionService.js';

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
    theme: 'dracula',
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

describe('Agent compaction threshold fallback', () => {
  it('uses a larger dynamic fallback output budget when maxOutputTokens is not configured', async () => {
    const agent = new Agent(createConfig());
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

    (agent as any).chatService = {
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 200000,
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      }),
    };

    const didCompact = await (agent as any).checkAndCompactInLoop(
      createContext(),
      2,
      148000
    );

    expect(didCompact).toBe(true);
    expect(compactSpy).toHaveBeenCalledOnce();
  });
});
