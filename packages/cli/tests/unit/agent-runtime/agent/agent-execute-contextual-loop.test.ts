import { describe, expect, it, vi } from 'vitest';

const { buildContextualLoopExecutionInputMock } = vi.hoisted(() => ({
  buildContextualLoopExecutionInputMock: vi.fn(),
}));

vi.mock('../../../../src/agent/buildContextualLoopExecutionInput.js', () => ({
  buildContextualLoopExecutionInput: buildContextualLoopExecutionInputMock,
}));

describe('Agent.executeContextualLoop', () => {
  it('builds execution input and forwards merged loop options to executeLoopInput', async () => {
    buildContextualLoopExecutionInputMock.mockResolvedValue({
      message: 'prepared-message',
      systemPrompt: 'prepared-system',
    });

    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.runtimeOptions = {
      systemPrompt: 'runtime-system',
      appendSystemPrompt: 'runtime-append',
    };
    agent.config = { language: 'zh-CN' };
    agent.executeLoopInput = vi.fn().mockResolvedValue({ success: true });

    const signal = new AbortController().signal;
    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: 'plan',
      signal,
    };

    await agent.executeContextualLoop('hello', context, { stream: true });

    expect(buildContextualLoopExecutionInputMock).toHaveBeenCalledWith({
      message: 'hello',
      context,
      runtimeOptions: {
        systemPrompt: 'runtime-system',
        appendSystemPrompt: 'runtime-append',
      },
      language: 'zh-CN',
      environmentContext: expect.any(String),
      specManager: expect.any(Object),
      onSpecInitializationWarning: expect.any(Function),
    });
    expect(agent.executeLoopInput).toHaveBeenCalledWith(
      {
        message: 'prepared-message',
        systemPrompt: 'prepared-system',
      },
      context,
      {
        signal,
        stream: true,
      }
    );
  });

  it('preserves explicit options while still injecting the context signal', async () => {
    buildContextualLoopExecutionInputMock.mockResolvedValue({
      message: 'prepared-message',
      systemPrompt: 'prepared-system',
    });

    const { Agent } = await import('../../../../src/agent/Agent.js');
    const agent = Object.create(Agent.prototype) as any;
    agent.runtimeOptions = {};
    agent.config = { language: 'zh-CN' };
    agent.executeLoopInput = vi.fn().mockResolvedValue({ success: true });

    const signal = new AbortController().signal;
    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: 'default',
      signal,
    };

    await agent.executeContextualLoop('hello', context, {
      stream: false,
      autoCompact: true,
    });

    expect(agent.executeLoopInput).toHaveBeenCalledWith(expect.any(Object), context, {
      signal,
      stream: false,
      autoCompact: true,
    });
  });
});
