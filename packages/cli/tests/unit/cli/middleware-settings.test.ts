import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOriginalCwd, setOriginalCwd } from '../../../src/bootstrap/state.js';

const configState = vi.hoisted(() => ({
  initialize: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock('../../../src/config/index.js', () => ({
  ConfigManager: {
    getInstance: () => ({ initialize: configState.initialize }),
  },
}));

vi.mock('../../../src/store/vanilla.js', () => ({
  getState: () => ({
    config: { actions: { setConfig: configState.setConfig } },
  }),
}));

describe('--settings middleware', () => {
  const temporaryDirectories: string[] = [];
  let previousOriginalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    configState.initialize.mockResolvedValue({ currentModelId: 'model' });
    previousOriginalCwd = getOriginalCwd();
  });

  afterEach(async () => {
    setOriginalCwd(previousOriginalCwd);
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads inline JSON as a temporary settings layer', async () => {
    const argv: Record<string, unknown> = {
      settings: JSON.stringify({
        appendSystemPrompt: 'INLINE_SETTINGS_RULE',
        maxTurns: 7,
        allowedTools: ['Read', 'Edit', 'Bash'],
      }),
    };
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await loadConfiguration(argv as never);

    expect(configState.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        appendSystemPrompt: 'INLINE_SETTINGS_RULE',
        maxTurns: 7,
        allowedTools: ['Read', 'Edit', 'Bash'],
      })
    );
    expect(argv).toMatchObject({
      appendSystemPrompt: 'INLINE_SETTINGS_RULE',
      maxTurns: 7,
      allowedTools: ['Read', 'Edit', 'Bash'],
    });
  });

  it('resolves a settings file from the original invocation directory', async () => {
    const invocationDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'blade-cli-settings-')
    );
    temporaryDirectories.push(invocationDirectory);
    setOriginalCwd(invocationDirectory);
    await writeFile(
      path.join(invocationDirectory, 'automation.json'),
      JSON.stringify({ appendSystemPrompt: 'FILE_SETTINGS_RULE' })
    );
    const argv: Record<string, unknown> = { settings: './automation.json' };
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await loadConfiguration(argv as never);

    expect(configState.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ appendSystemPrompt: 'FILE_SETTINGS_RULE' })
    );
    expect(argv.appendSystemPrompt).toBe('FILE_SETTINGS_RULE');
  });

  it('keeps explicit CLI arguments above settings values', async () => {
    const argv: Record<string, unknown> = {
      settings: JSON.stringify({
        appendSystemPrompt: 'SETTINGS_RULE',
        maxTurns: 3,
      }),
      appendSystemPrompt: 'EXPLICIT_CLI_RULE',
      maxTurns: 9,
    };
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await loadConfiguration(argv as never);

    expect(argv.appendSystemPrompt).toBe('EXPLICIT_CLI_RULE');
    expect(argv.maxTurns).toBe(9);
  });

  it('lets the explicit yolo shortcut override the settings permission mode', async () => {
    const argv: Record<string, unknown> = {
      settings: JSON.stringify({ permissionMode: 'default' }),
      yolo: true,
    };
    const { loadConfiguration, validatePermissions } = await import(
      '../../../src/cli/middleware.js'
    );

    await loadConfiguration(argv as never);
    expect(() => validatePermissions(argv as never)).not.toThrow();

    expect(argv.permissionMode).toBe('yolo');
  });

  it('fails closed for malformed or unknown settings', async () => {
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await expect(
      loadConfiguration({ settings: '{"appendSystemPrompt":' } as never)
    ).rejects.toThrow('Invalid JSON provided to --settings');
    await expect(
      loadConfiguration({ settings: '{"appendSystemPromt":"typo"}' } as never)
    ).rejects.toThrow('Unknown --settings field: appendSystemPromt');
    await expect(
      loadConfiguration({ settings: '{"maxContextTokens":"many"}' } as never)
    ).rejects.toThrow('Invalid --settings value: maxContextTokens');
  });

  it('validates invocation agents before initializing configuration', async () => {
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await expect(
      loadConfiguration({
        agents: JSON.stringify({
          reviewer: { description: 'Missing the required prompt' },
        }),
      } as never)
    ).rejects.toThrow('Invalid --agents definition for "reviewer"');

    expect(configState.initialize).not.toHaveBeenCalled();
  });

  it('validates fork session combinations before initializing configuration', async () => {
    const { loadConfiguration } = await import('../../../src/cli/middleware.js');

    await expect(loadConfiguration({ forkSession: true } as never)).rejects.toThrow(
      '--fork-session requires --resume or --continue'
    );
    await expect(
      loadConfiguration({ continue: true, resume: 'parent' } as never)
    ).rejects.toThrow('Cannot use both --continue and --resume');
    await expect(
      loadConfiguration({ sessionId: 'child', resume: 'parent' } as never)
    ).rejects.toThrow('--session-id can only be combined with --resume');

    expect(configState.initialize).not.toHaveBeenCalled();
  });
});
