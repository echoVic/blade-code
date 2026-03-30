import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildAgentExecutionInvocationMock = vi.fn();

vi.mock('../../../../src/agent/buildAgentExecutionInvocation.js', () => ({
  buildAgentExecutionInvocation: buildAgentExecutionInvocationMock,
}));

describe('Agent.executeLoop', () => {
  beforeEach(() => {
    buildAgentExecutionInvocationMock.mockReset();
  });

  it('packages a loop invocation before delegating to executeLoopInvocation', async () => {
    const invocation = { packed: true };
    buildAgentExecutionInvocationMock.mockReturnValue(invocation);

    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.executeLoopInvocation = vi.fn().mockResolvedValue({ success: true });

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    };
    const options = { stream: false };

    await agent.executeLoop('hello', context, options, 'system');

    expect(buildAgentExecutionInvocationMock).toHaveBeenCalledWith({
      message: 'hello',
      context,
      options,
      systemPrompt: 'system',
    });
    expect(agent.executeLoopInvocation).toHaveBeenCalledWith(invocation);
  });
});
