import { describe, expect, it, vi } from 'vitest';

describe('loadSpecLoopContext', () => {
  it('initializes the spec manager and returns the current spec context', async () => {
    const { loadSpecLoopContext } = await import(
      '../../../../src/agent/loadSpecLoopContext.js'
    );

    const currentSpec = {
      id: 'spec-1',
      name: 'agent-loop',
      description: 'Refactor the agent loop',
      phase: 'design',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T01:00:00.000Z',
      tasks: [],
    } as const;
    const specManager = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getCurrentSpec: vi.fn().mockReturnValue(currentSpec),
      getSteeringContextString: vi.fn().mockResolvedValue('project steering'),
    };

    const result = await loadSpecLoopContext({
      specManager: specManager as any,
      workspaceRoot: '/workspace/blade',
      onInitializationWarning: vi.fn(),
    });

    expect(specManager.initialize).toHaveBeenCalledWith('/workspace/blade');
    expect(result).toEqual({
      currentSpec,
      steeringContext: 'project steering',
    });
  });

  it('logs an initialization warning but still reads the current spec context', async () => {
    const { loadSpecLoopContext } = await import(
      '../../../../src/agent/loadSpecLoopContext.js'
    );

    const error = new Error('init warning');
    const onInitializationWarning = vi.fn();
    const specManager = {
      initialize: vi.fn().mockRejectedValue(error),
      getCurrentSpec: vi.fn().mockReturnValue(null),
      getSteeringContextString: vi.fn().mockResolvedValue(null),
    };

    const result = await loadSpecLoopContext({
      specManager: specManager as any,
      workspaceRoot: '/workspace/blade',
      onInitializationWarning,
    });

    expect(onInitializationWarning).toHaveBeenCalledWith(error);
    expect(result).toEqual({
      currentSpec: null,
      steeringContext: null,
    });
  });
});
