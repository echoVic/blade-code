import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const state = {
    executeCalls: [] as unknown[],
    mockPublish: vi.fn(),
    mockExecuteSubagentStopHooks: vi.fn(),
    mockExecutorExecute: vi.fn(),
  };

  state.mockExecutorExecute.mockImplementation(async (context: unknown) => {
    state.executeCalls.push(context);
    if (state.executeCalls.length === 1) {
      return {
        success: false,
        message: 'needs continuation',
        error: 'continue',
        agentId: 'agent-1',
        stats: { duration: 10 },
      };
    }

    return {
      success: true,
      message: 'done',
      agentId: 'agent-1',
      stats: { duration: 20, toolCalls: 1, tokens: 5 },
    };
  });

  return state;
});

vi.mock('../../../../../src/agent/subagents/SubagentExecutor.js', () => ({
  SubagentExecutor: vi.fn().mockImplementation(() => ({
    execute: mockState.mockExecutorExecute,
  })),
}));

vi.mock('../../../../../src/agent/subagents/SubagentRegistry.js', () => ({
  subagentRegistry: {
    getAllNames: () => ['Explore'],
    getDescriptionsForPrompt: () => 'Explore agent',
    getSubagent: () => ({
      name: 'Explore',
      description: 'Explore agent',
    }),
  },
}));

vi.mock('../../../../../src/agent/subagents/BackgroundAgentManager.js', () => ({
  BackgroundAgentManager: {
    getInstance: () => ({
      startBackgroundAgent: vi.fn(),
      resumeAgent: vi.fn(),
    }),
  },
}));

vi.mock('../../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      executeSubagentStopHooks: mockState.mockExecuteSubagentStopHooks,
    }),
  },
}));

vi.mock('../../../../../src/server/bus.js', () => ({
  Bus: {
    publish: mockState.mockPublish,
  },
}));

vi.mock('../../../../../src/store/vanilla.js', () => ({
  vanillaStore: {
    getState: () => ({
      app: {
        actions: {
          startSubagentProgress: vi.fn(),
          updateSubagentTool: vi.fn(),
          completeSubagentProgress: vi.fn(),
        },
      },
    }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'generated-session-id'),
}));

import { taskTool } from '../../../../../src/tools/builtin/task/task.js';

describe('Task Tool', () => {
  beforeEach(() => {
    mockState.executeCalls.length = 0;
    vi.clearAllMocks();
    mockState.mockExecuteSubagentStopHooks.mockResolvedValue({
      shouldStop: false,
      continueReason: 'keep going',
    });
  });

  it('preserves subagent callbacks and session id when stop hooks request continuation', async () => {
    const result = await taskTool.execute(
      {
        subagent_type: 'Explore',
        description: 'Explore repo',
        prompt: 'Inspect the repo and continue if needed',
        run_in_background: false,
      },
      undefined,
      {
        sessionId: 'parent-session',
      }
    );

    expect(result.success).toBe(true);
    expect(mockState.mockExecutorExecute).toHaveBeenCalledTimes(2);

    const firstContext = mockState.executeCalls[0] as Record<string, unknown>;
    const secondContext = mockState.executeCalls[1] as Record<string, unknown>;

    expect(firstContext.subagentSessionId).toBe('generated-session-id');
    expect(secondContext.subagentSessionId).toBe('generated-session-id');
    expect(secondContext.parentSessionId).toBe('parent-session');
    expect(secondContext.permissionMode).toBeUndefined();
    expect(secondContext.onToolStart).toBe(firstContext.onToolStart);
    expect(secondContext.onToolResult).toBe(firstContext.onToolResult);
    expect(secondContext.onContentDelta).toBe(firstContext.onContentDelta);
    expect(secondContext.onThinkingDelta).toBe(firstContext.onThinkingDelta);
    expect(secondContext.onStreamEnd).toBe(firstContext.onStreamEnd);
  });
});
