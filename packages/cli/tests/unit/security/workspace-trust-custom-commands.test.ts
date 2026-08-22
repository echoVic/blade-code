import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trusted: false,
  discover: vi.fn(),
}));

vi.mock('../../../src/security/WorkspaceTrustService.js', () => ({
  WorkspaceTrustService: {
    getInstance: () => ({
      getStatus: async () => ({
        state: mocks.trusted ? 'trusted' : 'untrusted',
      }),
    }),
  },
}));

vi.mock('../../../src/slash-commands/custom/CustomCommandLoader.js', () => ({
  CustomCommandLoader: class MockCustomCommandLoader {
    discover = mocks.discover;
    getCommandDirs = vi.fn();
  },
}));

vi.mock('../../../src/slash-commands/custom/CustomCommandExecutor.js', () => ({
  CustomCommandExecutor: class MockCustomCommandExecutor {
    execute = vi.fn();
    executePlugin = vi.fn();
  },
}));

import { CustomCommandRegistry } from '../../../src/slash-commands/custom/CustomCommandRegistry.js';

const command = (name: string, source: 'user' | 'project') => ({
  name,
  config: { description: `${name} command` },
  content: `Run ${name}`,
  path: `/workspace/${name}.md`,
  source,
  sourceDir: 'blade' as const,
});

describe('CustomCommandRegistry workspace trust gate', () => {
  beforeEach(() => {
    CustomCommandRegistry.resetInstance();
    mocks.trusted = false;
    mocks.discover.mockReset();
    mocks.discover.mockResolvedValue({
      commands: [
        command('user-command', 'user'),
        command('project-command', 'project'),
      ],
      scannedDirs: [],
      errors: [],
    });
  });

  it('keeps only user commands while the project is untrusted', async () => {
    const registry = CustomCommandRegistry.getInstance('/workspace');
    await registry.initialize('/workspace');

    expect(registry.getAllCommands().map((item) => item.name)).toEqual([
      'user-command',
    ]);
  });

  it('loads project commands after folder trust', async () => {
    mocks.trusted = true;
    const registry = CustomCommandRegistry.getInstance('/workspace');
    await registry.initialize('/workspace');

    expect(registry.getAllCommands().map((item) => item.name)).toEqual([
      'user-command',
      'project-command',
    ]);
  });
});
