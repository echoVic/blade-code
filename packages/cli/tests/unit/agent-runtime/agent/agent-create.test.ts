import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
import { PermissionMode, type BladeConfig } from '../../../../src/config/types.js';

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

describe('Agent.create', () => {
  it('rejects session-scoped creation and requires an explicit runtime owner', async () => {
    await expect(Agent.create({ sessionId: 'session-1' })).rejects.toThrow(
      'Agent.create() does not accept sessionId'
    );
  });
});

describe('Agent runLoop system prompt injection', () => {
  it('uses the builder result directly instead of hand-prepending environment', async () => {
    const agent = new Agent(createConfig(), {}, {
      getRegistry: () => ({ getAll: () => [] }),
    } as any);

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };

    (agent as any).buildSystemPromptOnDemand = vi.fn().mockResolvedValue('BASE_PROMPT');

    let receivedSystemPrompt: string | undefined;
    (agent as any).executeLoop = vi.fn(async function* (
      _message: string,
      _context: typeof context,
      _options: unknown,
      systemPrompt?: string
    ) {
      receivedSystemPrompt = systemPrompt;
      return {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const result = await (agent as any).runLoop('hello', context).next();

    expect(result.done).toBe(true);
    expect((agent as any).buildSystemPromptOnDemand).toHaveBeenCalledOnce();
    expect(receivedSystemPrompt).toBe('BASE_PROMPT');
  });
});
