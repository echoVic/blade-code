/**
 * Resume Slash Command
 * 恢复当前工作区的历史会话
 */

import path from 'node:path';
import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume a conversation',
  fullDescription:
    '恢复当前工作区的历史会话。可以指定 sessionId 直接恢复，或不带参数打开会话选择器',
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
      const resolvedWorkspace = path.resolve(context.cwd);
      const listedSessions = await SessionService.listSessions({
        cwd: resolvedWorkspace,
        includeSubagents: false,
      });
      const sessions = listedSessions.filter(
        (session) => path.resolve(session.projectPath) === resolvedWorkspace
      );

      if (args.length === 0) {
        if (sessions.length === 0) {
          return {
            success: false,
            error: 'No resumable sessions found in current workspace',
          };
        }
        return {
          success: true,
          data: { action: 'select_session', intent: 'resume', sessions },
        };
      }

      const sessionId = args[0]!;
      const session = sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session) {
        return { success: false, error: `Session not found: ${sessionId}` };
      }

      return {
        success: true,
        data: { action: 'activate_session', intent: 'resume', session },
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
