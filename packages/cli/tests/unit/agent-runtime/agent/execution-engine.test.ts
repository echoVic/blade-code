import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../../../../src/agent/ExecutionEngine.js';

const mockChatService = {
  chat: vi.fn().mockResolvedValue({
    content: 'Mock response',
    toolCalls: undefined,
  }),
  getConfig: vi
    .fn()
    .mockReturnValue({ apiKey: 'test-key', model: 'claude-3-5-sonnet-20240620' }),
  updateConfig: vi.fn(),
};

describe('ExecutionEngine', () => {
  let executionEngine: ExecutionEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    executionEngine = new ExecutionEngine(mockChatService as any);
  });

  it('executes a task with one user message', async () => {
    const response = await executionEngine.executeTask({
      id: 'test-task',
      type: 'simple',
      prompt: 'Test message',
    });

    expect(response).toEqual({
      taskId: 'test-task',
      content: 'Mock response',
      metadata: { taskType: 'simple' },
    });
    expect(mockChatService.chat).toHaveBeenCalledWith([
      { role: 'user', content: 'Test message' },
    ]);
    expect(executionEngine.getContextManager()).toBeDefined();
  });

  it('propagates chat service errors', async () => {
    mockChatService.chat.mockRejectedValueOnce(new Error('Execution Error'));

    await expect(
      executionEngine.executeTask({
        id: 'test-task',
        type: 'simple',
        prompt: 'Test message',
      })
    ).rejects.toThrow('Execution Error');
  });
});
