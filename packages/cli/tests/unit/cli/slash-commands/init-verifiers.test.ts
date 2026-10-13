import { describe, expect, it } from 'vitest';
import { executeSlashCommand } from '../../../../src/slash-commands/index.js';
import initVerifiersCommand from '../../../../src/slash-commands/initVerifiers.js';

describe('/init-verifiers', () => {
  it('dispatches project skill generation through the current Agent turn', async () => {
    const result = await executeSlashCommand('/init-verifiers', {
      cwd: '/workspace',
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'invoke_custom_command',
        commandName: 'init-verifiers',
        processedContent: expect.stringContaining(
          '.blade/skills/verify-<scope>/SKILL.md'
        ),
      },
    });
  });

  it('rejects trailing arguments and remote workspace access', async () => {
    expect(
      await initVerifiersCommand.handler(['extra'], { cwd: '/workspace' })
    ).toMatchObject({ success: false });
    expect(
      await initVerifiersCommand.handler([], {
        cwd: '/remote',
        workspaceKind: 'acp-remote',
      })
    ).toMatchObject({ success: false });
  });
});
