import { describe, expect, it, vi } from 'vitest';
import btwCommand from '../../../../src/slash-commands/btw.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

describe('/btw', () => {
  const createContext = (
    ask?: SlashCommandContext['sideConversation']
  ): SlashCommandContext => ({
    cwd: '/tmp/side-workspace',
    workspaceRoot: '/tmp/side-workspace',
    sessionId: 'side-session',
    sideConversation: ask,
  });

  it('returns an ephemeral side conversation result', async () => {
    const ask = vi.fn().mockResolvedValue({
      response: 'The failure came from the provider timeout.',
      durationMs: 42,
    });

    const result = await btwCommand.handler(
      ['What', 'failed?'],
      createContext({ ask })
    );

    expect(ask).toHaveBeenCalledWith('What failed?', undefined);
    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'show_side_conversation',
        question: 'What failed?',
        response: 'The failure came from the provider timeout.',
        durationMs: 42,
      },
    });
  });

  it('requires a question and an active Session runtime', async () => {
    await expect(btwCommand.handler([], createContext())).resolves.toEqual({
      success: false,
      error: 'Usage: /btw <question>',
    });
    await expect(
      btwCommand.handler(['What', 'failed?'], createContext())
    ).resolves.toEqual({
      success: false,
      error: 'Side conversations require an active Session runtime',
    });
  });
});
