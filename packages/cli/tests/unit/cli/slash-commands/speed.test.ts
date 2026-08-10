import { describe, expect, it, vi } from 'vitest';
import speedCommand from '../../../../src/slash-commands/speed.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';
import type {
  ServiceTierConfiguration,
  ServiceTierSelection,
} from '../../../../src/services/pi/serviceTier.js';

function context(
  overrides: Partial<NonNullable<SlashCommandContext['serviceTier']>> = {}
): SlashCommandContext {
  return {
    cwd: '/workspace',
    serviceTier: {
      get: vi.fn().mockResolvedValue({
        selection: 'auto',
        effective: 'provider-default',
        supported: ['standard', 'fast', 'flex'],
      }),
      set: vi.fn(
        async (selection: ServiceTierSelection): Promise<ServiceTierConfiguration> => ({
          selection,
          effective: selection === 'auto' ? 'provider-default' : selection,
          supported: ['standard', 'fast', 'flex'],
        })
      ),
      ...overrides,
    },
  };
}

describe('/speed slash command', () => {
  it('shows the current Session-owned service tier', async () => {
    const result = await speedCommand.handler([], context());
    expect(result).toMatchObject({
      success: true,
      data: {
        serviceTier: 'auto',
        effectiveServiceTier: 'provider-default',
      },
    });
    expect(result.message).toContain('Service tier: auto (provider-default)');
  });

  it('sets explicit tiers and supports /fast on/off vocabulary', async () => {
    const ctx = context();
    await expect(speedCommand.handler(['fast'], ctx)).resolves.toMatchObject({
      success: true,
      data: { serviceTier: 'fast' },
    });
    await expect(speedCommand.handler(['on'], ctx)).resolves.toMatchObject({
      success: true,
      data: { serviceTier: 'fast' },
    });
    await expect(speedCommand.handler(['off'], ctx)).resolves.toMatchObject({
      success: true,
      data: { serviceTier: 'standard' },
    });
    expect(ctx.serviceTier?.set).toHaveBeenNthCalledWith(1, 'fast');
    expect(ctx.serviceTier?.set).toHaveBeenNthCalledWith(2, 'fast');
    expect(ctx.serviceTier?.set).toHaveBeenNthCalledWith(3, 'standard');
  });

  it('fails closed without an owner or for invalid tiers', async () => {
    await expect(
      speedCommand.handler([], { cwd: '/workspace' })
    ).resolves.toMatchObject({ success: false });
    await expect(speedCommand.handler(['turbo'], context())).resolves.toMatchObject({
      success: false,
      error: 'Invalid service tier: turbo',
    });
  });
});
