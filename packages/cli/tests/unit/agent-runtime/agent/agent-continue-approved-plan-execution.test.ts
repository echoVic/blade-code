import { describe, expect, it, vi } from 'vitest';

const { setPermissionModeMock } = vi.hoisted(() => ({
  setPermissionModeMock: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', async () => {
  const actual = await vi.importActual('../../../../src/store/vanilla.js');
  return {
    ...actual,
    configActions: () => ({
      setPermissionMode: setPermissionModeMock,
    }),
  };
});

describe('Agent.continueApprovedPlanExecution', () => {
  it('updates the permission mode and reruns the loop through executeContextualLoop', async () => {
    setPermissionModeMock.mockResolvedValue(undefined);

    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.executeContextualLoop = vi.fn().mockResolvedValue({
      success: true,
      finalMessage: 'done',
    });

    const continuation = {
      message: 'rerun with approved plan',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: 'default',
      },
    };

    const result = await agent.continueApprovedPlanExecution(continuation, {
      stream: false,
    });

    expect(setPermissionModeMock).toHaveBeenCalledWith('default');
    expect(agent.executeContextualLoop).toHaveBeenCalledWith(
      'rerun with approved plan',
      continuation.context,
      { stream: false }
    );
    expect(result).toBe('done');
  });
});
