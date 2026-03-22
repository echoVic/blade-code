import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginState = vi.hoisted(() => ({
  initialize: vi.fn(),
  integrateAllPlugins: vi.fn(),
}));

const slashState = vi.hoisted(() => ({
  isSlashCommand: vi.fn(),
  executeSlashCommand: vi.fn(),
}));

vi.mock('../../../src/plugins/index.js', () => ({
  getPluginRegistry: vi.fn(() => ({
    initialize: pluginState.initialize,
  })),
  integrateAllPlugins: pluginState.integrateAllPlugins,
}));

vi.mock('../../../src/slash-commands/index.js', () => ({
  isSlashCommand: slashState.isSlashCommand,
  executeSlashCommand: slashState.executeSlashCommand,
}));

describe('command input helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginState.initialize.mockResolvedValue({ plugins: [] });
    pluginState.integrateAllPlugins.mockResolvedValue(undefined);
    slashState.isSlashCommand.mockReturnValue(false);
  });

  it('initializes plugins and only integrates when plugins are present', async () => {
    const { initializeCliPlugins } = await import('../../../src/commands/shared/commandInput.js');

    await initializeCliPlugins();
    expect(pluginState.integrateAllPlugins).not.toHaveBeenCalled();

    pluginState.initialize.mockResolvedValueOnce({ plugins: [{ name: 'demo' }] });
    await initializeCliPlugins();
    expect(pluginState.integrateAllPlugins).toHaveBeenCalledTimes(1);
  });

  it('normalizes slash command requests into agent prompts', async () => {
    slashState.isSlashCommand.mockReturnValue(true);
    slashState.executeSlashCommand.mockResolvedValue({
      success: true,
      data: {
        action: 'invoke_skill',
        skillName: 'brainstorming',
        skillArgs: 'design a runner',
      },
    });

    const { normalizeCliInput } = await import('../../../src/commands/shared/commandInput.js');
    const result = await normalizeCliInput('/brainstorming design a runner');

    expect(result).toEqual({
      mode: 'agent',
      content: 'Please use the "brainstorming" skill to help me with: design a runner',
    });
  });
});
