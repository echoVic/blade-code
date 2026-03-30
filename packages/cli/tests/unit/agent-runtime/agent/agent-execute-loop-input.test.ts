import { describe, expect, it, vi } from 'vitest';

describe('Agent.executeLoopInput', () => {
  it('delegates prepared loop input through executeLoop', async () => {
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.executeLoop = vi.fn().mockResolvedValue({ success: true });

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };
    const options = { stream: false };
    const executionInput = {
      message: 'prepared-message',
      systemPrompt: 'prepared-system-prompt',
    };

    await agent.executeLoopInput(executionInput, context, options);

    expect(agent.executeLoop).toHaveBeenCalledWith(
      'prepared-message',
      context,
      options,
      'prepared-system-prompt'
    );
  });
});
