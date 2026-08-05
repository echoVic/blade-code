import path from 'node:path';
import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

function normalizeWorkspace(workspace: string): string {
  return path.resolve(workspace);
}

function getForkableSessions(
  sessions: Awaited<ReturnType<typeof SessionService.listSessions>>,
  workspace: string
) {
  const resolvedWorkspace = normalizeWorkspace(workspace);
  return sessions.filter((session) => {
    if (session.relationType === 'subagent') {
      return false;
    }
    return normalizeWorkspace(session.projectPath) === resolvedWorkspace;
  });
}

export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork a conversation into an independent session branch',
  fullDescription:
    '从当前工作区的历史会话创建独立分支。可以指定 sessionId 直接 fork，或不带参数打开会话选择器。',
  usage: '/fork [sessionId]',
  category: 'Session',
  examples: ['/fork - 打开会话选择器', '/fork parent-session - 直接 fork 指定会话'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    if (args.length > 1) {
      return {
        success: false,
        error: 'Usage: /fork [sessionId]',
      };
    }

    try {
      const listedSessions = await SessionService.listSessions({
        cwd: context.cwd,
        includeSubagents: false,
      });

      const forkableSessions = getForkableSessions(listedSessions, context.cwd);

      if (args.length === 0) {
        if (forkableSessions.length === 0) {
          return {
            success: false,
            error: 'No forkable sessions found in current workspace',
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
      const listedMatch = listedSessions.find(
        (session) =>
          session.sessionId === sessionId &&
          normalizeWorkspace(session.projectPath) === normalizeWorkspace(context.cwd)
      );
      if (listedMatch?.relationType === 'subagent') {
        return {
          success: false,
          error: `Cannot fork subagent session: ${sessionId}`,
        };
      }

      const selectedSession = forkableSessions.find(
        (session) => session.sessionId === sessionId
      );
      if (!selectedSession) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      return {
        success: true,
        data: {
          action: 'activate_session',
          intent: 'fork',
          session: selectedSession,
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
