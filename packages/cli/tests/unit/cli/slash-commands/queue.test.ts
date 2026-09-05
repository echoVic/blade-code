import { describe, expect, it } from 'vitest';
import { executeSlashCommand } from '../../../../src/slash-commands/index.js';
import queueCommand from '../../../../src/slash-commands/queue.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

describe('/queue', () => {
  const localContext: SlashCommandContext = {
    cwd: '/workspace/local',
    workspaceRoot: '/workspace/local',
    workspaceKind: 'local',
    surface: 'tui',
    sessionId: 'session-1',
  };

  it('opens the in-process queue control for a local TUI Session', async () => {
    await expect(queueCommand.handler([], localContext)).resolves.toEqual({
      success: true,
      message: 'show_follow_up_queue',
      data: { action: 'show_follow_up_queue' },
    });
  });

  it('requires a local TUI Session and rejects arguments', async () => {
    await expect(
      queueCommand.handler([], { cwd: '/workspace/local', surface: 'tui' })
    ).resolves.toEqual({
      success: false,
      error: 'Follow-up queue control requires an active local TUI Session',
    });
    await expect(queueCommand.handler(['extra'], localContext)).resolves.toEqual({
      success: false,
      error: 'Usage: /queue',
    });
  });

  it('is unavailable for an ACP remote history surface', async () => {
    await expect(
      executeSlashCommand('/queue', {
        ...localContext,
        workspaceKind: 'acp-remote',
      })
    ).resolves.toEqual({
      success: false,
      error: 'This command is unavailable for ACP remote workspaces',
    });
  });
});
