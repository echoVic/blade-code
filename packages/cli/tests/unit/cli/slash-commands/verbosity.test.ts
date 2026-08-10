import { describe, expect, it, vi } from 'vitest';
import type {
  ResponseVerbosityConfiguration,
  ResponseVerbositySelection,
} from '../../../../src/services/pi/responseVerbosity.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';
import verbosityCommand from '../../../../src/slash-commands/verbosity.js';

function context(
  overrides: Partial<NonNullable<SlashCommandContext['responseVerbosity']>> = {}
): SlashCommandContext {
  return {
    cwd: '/workspace',
    responseVerbosity: {
      get: vi.fn().mockResolvedValue({
        selection: 'auto',
        effective: 'provider-default',
        supported: ['low', 'medium', 'high'],
      }),
      set: vi.fn(
        async (
          selection: ResponseVerbositySelection
        ): Promise<ResponseVerbosityConfiguration> => ({
          selection,
          effective: selection === 'auto' ? 'provider-default' : selection,
          supported: ['low', 'medium', 'high'],
        })
      ),
      ...overrides,
    },
  };
}

describe('/verbosity slash command', () => {
  it('shows the current Session-owned response verbosity', async () => {
    const result = await verbosityCommand.handler([], context());
    expect(result).toMatchObject({
      success: true,
      data: {
        responseVerbosity: 'auto',
        effectiveResponseVerbosity: 'provider-default',
      },
    });
    expect(result.message).toContain('Response verbosity: auto (provider-default)');
  });

  it('sets explicit verbosity through the /detail alias vocabulary', async () => {
    const ctx = context();
    await expect(verbosityCommand.handler(['high'], ctx)).resolves.toMatchObject({
      success: true,
      data: { responseVerbosity: 'high' },
    });
    expect(ctx.responseVerbosity?.set).toHaveBeenCalledWith('high');
  });

  it('fails closed without an owner or for invalid verbosity', async () => {
    await expect(
      verbosityCommand.handler([], { cwd: '/workspace' })
    ).resolves.toMatchObject({ success: false });
    await expect(
      verbosityCommand.handler(['verbose'], context())
    ).resolves.toMatchObject({
      success: false,
      error: 'Invalid response verbosity: verbose',
    });
  });
});
