import { getSubagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import { TeamRuntime, type TeamSnapshot } from '../agent/teams/TeamRuntime.js';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import { getState } from '../store/vanilla.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

function runtimeFor(context: SlashCommandContext): TeamRuntime {
  const workspaceRoot = context.workspaceRoot ?? context.cwd;
  return new TeamRuntime({
    configDir: getBladeStorageRoot(),
    subagentRegistry: getSubagentRegistry(workspaceRoot),
  });
}

function ownerFor(context: SlashCommandContext) {
  if (!context.sessionId) {
    throw new Error('Agent Teams require an active Session');
  }
  return {
    sessionId: context.sessionId,
    projectPath: context.workspaceRoot ?? context.cwd,
  };
}

function renderTeam(team: TeamSnapshot): string {
  const memberLines = team.members
    .filter((member) => member.status !== 'leader')
    .map(
      (member) =>
        `- ${member.name}: ${member.status} (${member.subagentType})` +
        (member.worktreePath ? ' [worktree]' : '')
    );
  const taskLines = team.tasks.map(
    (task) =>
      `- #${task.id} [${task.status}] ${task.subject}` +
      (task.owner ? ` (${task.owner})` : '')
  );
  return [
    `### ${team.name}`,
    `${team.status} | ${team.members.length - 1} members | ${team.tasks.length} tasks`,
    ...(team.description ? ['', team.description] : []),
    '',
    '**Members**',
    ...(memberLines.length > 0 ? memberLines : ['- None']),
    '',
    '**Tasks**',
    ...(taskLines.length > 0 ? taskLines : ['- None']),
  ].join('\n');
}

const teamCommand: SlashCommand = {
  name: 'team',
  description: 'Inspect and coordinate Agent Teams',
  fullDescription:
    'List teams, inspect shared task graphs, message teammates, or delete a team.',
  usage:
    '/team [list|status <name>|message <name> <recipient> <text>|inbox <name>|delete <name>]',
  category: 'agent',
  handler: async (
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> => {
    if (getState().config.config?.agentTeamsEnabled !== true) {
      return {
        success: false,
        error: 'Agent Teams are disabled. Set agentTeamsEnabled to true.',
      };
    }

    try {
      const runtime = runtimeFor(context);
      const owner = ownerFor(context);
      const action = args[0]?.toLowerCase() ?? 'list';

      if (action === 'list') {
        const teams = await runtime.list(owner);
        return {
          success: true,
          content:
            teams.length > 0
              ? teams.map(renderTeam).join('\n\n')
              : 'No Agent Teams for this Session.',
        };
      }

      if (action === 'status') {
        const name = args[1];
        if (!name) return { success: false, error: 'Usage: /team status <name>' };
        return {
          success: true,
          content: renderTeam(await runtime.getSnapshot(name, owner)),
        };
      }

      if (action === 'message') {
        const [name, recipient, ...bodyParts] = args.slice(1);
        const body = bodyParts.join(' ').trim();
        if (!name || !recipient || !body) {
          return {
            success: false,
            error: 'Usage: /team message <name> <recipient|*> <message>',
          };
        }
        const messages = await runtime.sendMessage({
          name,
          to: recipient,
          body,
          owner,
        });
        return {
          success: true,
          content: `Sent to ${messages.map((message) => message.to).join(', ')}.`,
        };
      }

      if (action === 'inbox') {
        const name = args[1];
        if (!name) return { success: false, error: 'Usage: /team inbox <name>' };
        const messages = await runtime.inbox({
          name,
          recipient: 'team-lead',
          owner,
        });
        return {
          success: true,
          content:
            messages.length > 0
              ? messages
                  .map(
                    (message) =>
                      `- ${message.from}: ${message.body}` +
                      (message.acknowledgedAt ? ' [acknowledged]' : '')
                  )
                  .join('\n')
              : 'Team inbox is empty.',
        };
      }

      if (action === 'delete') {
        const name = args[1];
        if (!name) return { success: false, error: 'Usage: /team delete <name>' };
        const team = await runtime.delete(name, { owner, killRunning: true });
        return { success: true, content: `Deleted Agent Team ${team.name}.` };
      }

      return {
        success: false,
        error:
          'Usage: /team [list|status <name>|message <name> <recipient> <text>|inbox <name>|delete <name>]',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export default teamCommand;
