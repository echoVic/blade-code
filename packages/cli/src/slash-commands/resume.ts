/**
 * Resume Slash Command
 * 恢复任意已发现工作区的历史会话
 */

import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume a conversation',
  fullDescription:
    '恢复任意工作区的历史会话。可以指定唯一 sessionId 直接恢复，或不带参数打开会话选择器',
  usage: '/resume [sessionId]',
  aliases: ['r'],
  category: 'Session',
  examples: ['/resume - 打开会话选择器', '/resume abc123xyz - 直接恢复指定的会话'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    if (args.length > 1) {
      return { success: false, error: 'Usage: /resume [sessionId]' };
    }

    try {
      const listedSessions = context.sessionSurfaces
        ? await context.sessionSurfaces.list()
        : await SessionService.listSessions({ includeSubagents: false });
      const sessions = listedSessions.filter(
        (session) => session.relationType !== 'subagent'
      );

      if (args.length === 0) {
        if (sessions.length === 0) {
          return {
            success: false,
            error: 'No resumable sessions found',
          };
        }
        return {
          success: true,
          data: { action: 'select_session', intent: 'resume', sessions },
        };
      }

      const sessionId = args[0]!;
      const matches = sessions.filter((candidate) =>
        'locator' in candidate
          ? candidate.locator.sessionId === sessionId
          : candidate.sessionId === sessionId
      );
      if (matches.length === 0) {
        return { success: false, error: `Session not found: ${sessionId}` };
      }
      if (matches.length > 1) {
        return {
          success: false,
          error: `Multiple workspaces contain session ${sessionId}; use /resume to select one`,
        };
      }

      return {
        success: true,
        data: { action: 'activate_session', intent: 'resume', session: matches[0] },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  },
};

export default resumeCommand;
