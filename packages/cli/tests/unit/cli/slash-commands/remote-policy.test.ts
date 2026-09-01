import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceResourceMocks = vi.hoisted(() => ({
  resolveWorkspaceAgentResources: vi.fn(async () => {
    throw new Error('host workspace discovery was invoked');
  }),
}));

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/agent/resources/WorkspaceAgentResources.js')
  >('../../../../src/agent/resources/WorkspaceAgentResources.js');
  return {
    ...actual,
    resolveWorkspaceAgentResources:
      workspaceResourceMocks.resolveWorkspaceAgentResources,
  };
});

import {
  executeSlashCommand,
  getRegisteredCommands,
} from '../../../../src/slash-commands/index.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

const REMOTE_SAFE_COMMANDS = [
  'btw',
  'effort',
  'help',
  'speed',
  'style',
  'verbosity',
  'version',
];

function createRemoteContext(sendMessage = vi.fn()): SlashCommandContext {
  return {
    cwd: '/private/remote-state',
    workspaceRoot: '/private/remote-state',
    workspaceKind: 'acp-remote',
    acp: { sendMessage },
  };
}

describe('ACP remote slash command policy', () => {
  beforeEach(() => {
    workspaceResourceMocks.resolveWorkspaceAgentResources.mockClear();
  });

  it('advertises only the canonical remote-safe command allowlist', () => {
    const commands = getRegisteredCommands(
      '/private/remote-state',
      undefined,
      'acp-remote'
    );

    expect(commands.map((command) => command.name).sort()).toEqual(
      REMOTE_SAFE_COMMANDS
    );
  });

  it('keeps the local command catalog unchanged', () => {
    const names = getRegisteredCommands('/private/local-workspace').map(
      (command) => command.name
    );

    expect(names).toContain('git');
    expect(names).toContain('init');
    expect(names).toContain('review');
  });

  it('rejects blocked and unknown commands before host workspace discovery', async () => {
    await expect(
      executeSlashCommand('/git status', createRemoteContext())
    ).resolves.toMatchObject({
      success: false,
    });
    await expect(
      executeSlashCommand('/project-custom-command', createRemoteContext())
    ).resolves.toMatchObject({
      success: false,
    });
    expect(
      workspaceResourceMocks.resolveWorkspaceAgentResources
    ).not.toHaveBeenCalled();
  });

  it('keeps canonical aliases while rendering only remote-safe help entries', async () => {
    const sendMessage = vi.fn();
    const context = createRemoteContext(sendMessage);

    await expect(executeSlashCommand('/v', context)).resolves.toMatchObject({
      success: true,
    });
    const help = await executeSlashCommand('/h', context);

    expect(help.success).toBe(true);
    expect(help.content).toContain('/help');
    expect(help.content).toContain('/version');
    expect(help.content).toContain('/btw');
    expect(help.content).not.toContain('/init');
    expect(help.content).not.toContain('/git');
    expect(help.content).not.toContain('/agents');
    expect(help.content).not.toContain('/memory');
    expect(
      workspaceResourceMocks.resolveWorkspaceAgentResources
    ).not.toHaveBeenCalled();
  });
});
