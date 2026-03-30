import { describe, expect, it, vi } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { runAgentLoop } from '../../../../src/agent/runAgentLoop.js';

describe('runAgentLoop', () => {
  it('returns chat_disabled when maxTurns is set to 0', async () => {
    const result = await runAgentLoop({
      message: 'hello',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.DEFAULT,
        systemPrompt: 'system',
      },
      options: { stream: false, maxTurns: 0 },
      systemPrompt: 'system',
      dependencies: {
        config: {
          maxTurns: -1,
          maxContextTokens: 32000,
          debug: false,
        } as any,
        runtimeOptions: {},
        currentModelMaxContextTokens: 32000,
        executionPipeline: {
          getRegistry: () => ({
            getFunctionDeclarationsByMode: () => [],
            getReadOnlyTools: () => [],
            get: () => undefined,
          }),
          execute: vi.fn(),
        } as any,
        executionEngine: {
          getContextManager: () => undefined,
        } as any,
        chatService: {
          getConfig: () => ({
            model: 'test-model',
            maxContextTokens: 32000,
            maxOutputTokens: 4096,
          }),
        } as any,
        applySkillToolRestrictions: (tools) => tools,
        processStreamResponse: vi.fn(),
        checkAndCompactInLoop: vi.fn(),
        switchModelIfNeeded: vi.fn(),
        activateSkillContext: vi.fn(),
        setTodos: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('chat_disabled');
    expect(result.metadata).toMatchObject({
      configuredMaxTurns: 0,
      actualMaxTurns: 0,
      turnsCount: 0,
    });
  });
});
