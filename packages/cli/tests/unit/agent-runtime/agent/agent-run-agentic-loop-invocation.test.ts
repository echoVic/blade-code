import { describe, expect, it, vi } from 'vitest';

describe('Agent.runAgenticLoopInvocation', () => {
  it('normalizes chat context and routes through executeContextualLoop', async () => {
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.isInitialized = true;
    agent.executeContextualLoop = vi.fn().mockResolvedValue({ success: true });

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: '/workspace/project',
      permissionMode: 'plan',
      systemPrompt: 'system',
      subagentInfo: {
        parentSessionId: 'parent-1',
        subagentType: 'Explore',
        isSidechain: false,
      },
    };
    const options = { stream: false };

    await agent.runAgenticLoopInvocation({
      message: 'hello',
      context,
      options,
    });

    expect(agent.executeContextualLoop).toHaveBeenCalledWith(
      'hello',
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: '/workspace/project',
        signal: undefined,
        confirmationHandler: undefined,
        permissionMode: 'plan',
        systemPrompt: 'system',
        subagentInfo: {
          parentSessionId: 'parent-1',
          subagentType: 'Explore',
          isSidechain: false,
        },
      },
      options
    );
  });
});
