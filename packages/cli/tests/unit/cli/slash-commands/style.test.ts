import { describe, expect, it, vi } from 'vitest';
import type {
  CommunicationStyleConfiguration,
  CommunicationStyleSelection,
} from '../../../../src/services/communicationStyle.js';
import styleCommand from '../../../../src/slash-commands/style.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

function context(
  overrides: Partial<NonNullable<SlashCommandContext['communicationStyle']>> = {}
): SlashCommandContext {
  const supported = [
    {
      id: 'auto' as const,
      name: 'Auto',
      description: 'Use the Blade default communication style',
      source: 'built-in' as const,
    },
    {
      id: 'friendly' as const,
      name: 'Friendly',
      description: 'Warm and collaborative',
      source: 'built-in' as const,
    },
    {
      id: 'project:strict' as const,
      name: 'Strict',
      description: 'Strict project communication',
      source: 'project' as const,
    },
  ];
  return {
    cwd: '/workspace',
    communicationStyle: {
      get: vi.fn().mockResolvedValue({
        selection: 'auto',
        effective: 'blade-default',
        name: 'Auto',
        description: 'Use the Blade default communication style',
        source: 'built-in',
        supported,
      }),
      set: vi.fn(
        async (
          selection: CommunicationStyleSelection
        ): Promise<CommunicationStyleConfiguration> => ({
          selection,
          effective: selection === 'auto' ? 'blade-default' : selection,
          name: selection,
          description: `Use ${selection}`,
          source: 'built-in',
          supported,
        })
      ),
      ...overrides,
    },
  };
}

describe('/style slash command', () => {
  it('shows the current Session-owned communication style', async () => {
    const result = await styleCommand.handler([], context());
    expect(result).toMatchObject({
      success: true,
      data: {
        communicationStyle: 'auto',
        effectiveCommunicationStyle: 'blade-default',
      },
    });
    expect(result.message).toContain('Communication style: auto (blade-default)');
  });

  it('sets explicit styles through the /personality alias vocabulary', async () => {
    const ctx = context();
    await expect(styleCommand.handler(['friendly'], ctx)).resolves.toMatchObject({
      success: true,
      data: { communicationStyle: 'friendly' },
    });
    expect(ctx.communicationStyle?.set).toHaveBeenCalledWith('friendly');
  });

  it('sets a namespaced custom style without accepting a path or raw prompt', async () => {
    const ctx = context();
    await expect(styleCommand.handler(['project:strict'], ctx)).resolves.toMatchObject({
      success: true,
      data: { communicationStyle: 'project:strict' },
    });
    expect(ctx.communicationStyle?.set).toHaveBeenCalledWith('project:strict');
    await expect(styleCommand.handler(['/tmp/style.md'], ctx)).resolves.toMatchObject({
      success: false,
      error: 'Invalid communication style: /tmp/style.md',
    });
  });

  it('fails closed without an owner or for invalid styles', async () => {
    await expect(
      styleCommand.handler([], { cwd: '/workspace' })
    ).resolves.toMatchObject({ success: false });
    await expect(styleCommand.handler(['learning'], context())).resolves.toMatchObject({
      success: false,
      error: 'Invalid communication style: learning',
    });
  });
});
