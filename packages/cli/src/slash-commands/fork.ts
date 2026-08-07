import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

function getForkableSessions(
  sessions: Awaited<ReturnType<typeof SessionService.listSessions>>
) {
  return sessions.filter((session) => session.relationType !== 'subagent');
}

export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork a conversation into an independent session branch',
  fullDescription:
    '从任意工作区的历史会话创建独立分支。可以指定唯一 sessionId 直接 fork，或不带参数打开会话选择器。',
  usage: '/fork [sessionId]',
  category: 'Session',
  examples: ['/fork - 打开会话选择器', '/fork parent-session - 直接 fork 指定会话'],
  async handler(
    args: string[],
    _context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /fork [sessionId]',
      };
    }

    try {
      const listedSessions = await SessionService.listSessions({
        includeSubagents: false,
      });

      const forkableSessions = getForkableSessions(listedSessions);

      if (args.length === 0) {
        if (forkableSessions.length === 0) {
          return {
            success: false,
            error: 'No forkable sessions found',
          };
        }

        return {
          success: true,
          data: {
            action: 'select_session',
            intent: 'fork',
            sessions: forkableSessions,
          },
        };
      }

      const sessionId = args[0]!;
      const listedMatches = listedSessions.filter(
        (session) => session.sessionId === sessionId
      );
      if (
        listedMatches.length > 0 &&
        listedMatches.every((session) => session.relationType === 'subagent')
      ) {
        return {
          success: false,
          error: `Cannot fork subagent session: ${sessionId}`,
        };
      }

      const selectedSessions = forkableSessions.filter(
        (session) => session.sessionId === sessionId
      );
      if (selectedSessions.length === 0) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }
      if (selectedSessions.length > 1) {
        return {
          success: false,
          error: `Multiple workspaces contain session ${sessionId}; use /fork to select one`,
        };
      }

      return {
        success: true,
        data: {
          action: 'activate_session',
          intent: 'fork',
          session: selectedSessions[0],
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  },
};

export default forkCommand;
