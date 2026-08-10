import { describe, expect, it, vi } from 'vitest';
import type {
  ReasoningEffortConfiguration,
  ReasoningEffortSelection,
} from '../../../../src/services/pi/reasoningEffort.js';
import effortCommand from '../../../../src/slash-commands/effort.js';

const low: ReasoningEffortConfiguration = {
  selection: 'low' as const,
  effective: 'low' as const,
  supported: ['off', 'minimal', 'low', 'medium', 'high'],
};

describe('/effort slash command', () => {
  it('shows the current Session-owned configuration', async () => {
    const get = vi.fn(async () => low);
    const result = await effortCommand.handler([], {
      cwd: '/workspace',
      sessionId: 'session-1',
      reasoning: {
        get,
        set: vi.fn(),
      },
    });
    expect(result).toMatchObject({
      success: true,
      message: expect.stringContaining('Reasoning effort: low'),
      data: {
        reasoningEffort: 'low',
        effectiveReasoningEffort: 'low',
      },
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it('sets explicit and auto levels through the owning surface', async () => {
    const set = vi.fn(
      async (
        selection: ReasoningEffortSelection
      ): Promise<ReasoningEffortConfiguration> => ({
        selection,
        effective: 'high' as const,
        supported: ['off', 'low', 'medium', 'high'],
      })
    );
    const context = {
      cwd: '/workspace',
      sessionId: 'session-1',
      reasoning: {
        get: vi.fn(),
        set,
      },
    };
    await expect(effortCommand.handler(['high'], context)).resolves.toMatchObject({
      success: true,
      data: { reasoningEffort: 'high' },
    });
    await expect(effortCommand.handler(['auto'], context)).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining('auto (high)'),
    });
    expect(set).toHaveBeenNthCalledWith(1, 'high');
    expect(set).toHaveBeenNthCalledWith(2, 'auto');
  });

  it('fails closed without an owner or for invalid levels', async () => {
    await expect(
      effortCommand.handler([], { cwd: '/workspace' })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('no active Session reasoning boundary'),
    });
    const context = {
      cwd: '/workspace',
      reasoning: { get: vi.fn(), set: vi.fn() },
    };
    await expect(effortCommand.handler(['ultra'], context)).resolves.toMatchObject({
      success: false,
      error: 'Invalid reasoning effort: ultra',
    });
    expect(context.reasoning.set).not.toHaveBeenCalled();
  });
});
