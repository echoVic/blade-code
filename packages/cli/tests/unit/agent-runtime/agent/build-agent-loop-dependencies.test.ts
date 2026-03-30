import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/agent/streamResponse.js', () => ({
  processStreamResponse: vi.fn().mockResolvedValue({ content: 'streamed' }),
}));

vi.mock('../../../../src/agent/loopCompaction.js', () => ({
  checkAndCompactInLoop: vi.fn().mockResolvedValue(true),
}));

import { buildAgentLoopDependencies } from '../../../../src/agent/buildAgentLoopDependencies.js';
import { checkAndCompactInLoop } from '../../../../src/agent/loopCompaction.js';
import { processStreamResponse } from '../../../../src/agent/streamResponse.js';

describe('buildAgentLoopDependencies', () => {
  it('bridges agent runtime services into loop dependencies', async () => {
    const applySkillToolRestrictions = vi.fn((tools) => tools.slice(0, 1));
    const activateSkillContext = vi.fn();
    const switchModelIfNeeded = vi.fn().mockResolvedValue(undefined);
    const setTodos = vi.fn();
    const log = vi.fn();
    const error = vi.fn();
    const chatService = { chat: vi.fn(), getConfig: vi.fn() } as any;
    const executionPipeline = { getRegistry: vi.fn(), execute: vi.fn() } as any;
    const executionEngine = { getContextManager: vi.fn() } as any;
    const config = { maxTurns: -1 } as any;
    const runtimeOptions = { maxTurns: 7 };

    const dependencies = buildAgentLoopDependencies({
      runtimeState: {
        config,
        runtimeOptions,
        currentModelMaxContextTokens: 32000,
        executionPipeline,
        executionEngine,
        chatService,
      },
      loopController: {
        applySkillToolRestrictions,
        activateSkillContext,
        switchModelIfNeeded,
        setTodos,
        log,
        error,
      },
    });

    expect(dependencies.config).toBe(config);
    expect(dependencies.runtimeOptions).toBe(runtimeOptions);
    expect(dependencies.currentModelMaxContextTokens).toBe(32000);
    expect(dependencies.executionPipeline).toBe(executionPipeline);
    expect(dependencies.executionEngine).toBe(executionEngine);
    expect(dependencies.chatService).toBe(chatService);
    expect(dependencies.applySkillToolRestrictions(['Read', 'Edit'] as any)).toEqual(['Read']);
    expect(applySkillToolRestrictions).toHaveBeenCalledWith(['Read', 'Edit']);

    await dependencies.processStreamResponse(
      [{ role: 'user', content: 'hello' }],
      [{ name: 'Read' }] as any,
      { stream: true }
    );
    expect(processStreamResponse).toHaveBeenCalledWith({
      chatService,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'Read' }],
      options: { stream: true },
    });

    await dependencies.checkAndCompactInLoop(
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      3,
      900,
      vi.fn()
    );
    expect(checkAndCompactInLoop).toHaveBeenCalledWith({
      context: expect.objectContaining({ sessionId: 'session-1' }),
      currentTurn: 3,
      actualPromptTokens: 900,
      onCompacting: expect.any(Function),
      chatService,
      config,
      executionEngine,
    });

    await dependencies.switchModelIfNeeded('gpt-5.4');
    expect(switchModelIfNeeded).toHaveBeenCalledWith('gpt-5.4');

    dependencies.activateSkillContext({ skillName: 'brainstorming' });
    expect(activateSkillContext).toHaveBeenCalledWith({ skillName: 'brainstorming' });

    dependencies.setTodos([{ id: '1', content: 'do it' }] as any);
    expect(setTodos).toHaveBeenCalledWith([{ id: '1', content: 'do it' }]);

    dependencies.log('hello');
    dependencies.error('boom');
    expect(log).toHaveBeenCalledWith('hello');
    expect(error).toHaveBeenCalledWith('boom');
  });
});
