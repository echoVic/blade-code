import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

async function resolveUniqueSession(
  sessionId: string,
  archived: boolean
): Promise<SlashCommandResult | { projectPath: string }> {
  const matches = (
    await SessionService.listSessions({
      includeSubagents: false,
      archived,
    })
  ).filter((session) => session.sessionId === sessionId);
  if (matches.length === 0) {
    return {
      success: false,
      error: `${archived ? 'Archived session' : 'Session'} not found: ${sessionId}`,
    };
  }
  if (matches.length > 1) {
    return {
      success: false,
      error: `Multiple workspaces contain session ${sessionId}`,
    };
  }
  return { projectPath: matches[0]!.projectPath };
}

export const archiveCommand: SlashCommand = {
  name: 'archive',
  description: 'Move an inactive session tree out of the active catalog',
  fullDescription:
    '归档一个已停止的会话及其 fork/subagent 后代。Transcript、任务证据和 worktree 元数据都会保留，可通过 /unarchive 恢复。',
  usage: '/archive [sessionId]',
  category: 'Session',
  examples: ['/archive', '/archive web-abc123'],
  async handler(args, context): Promise<SlashCommandResult> {
    if (args.length > 1) {
      return { success: false, error: 'Usage: /archive [sessionId]' };
    }
    try {
      if (args.length === 0) {
        if (!context.lifecycle || !context.sessionId) {
          return {
            success: false,
            error:
              'Current surface cannot archive its active session; provide a session ID',
          };
        }
        const archived = await context.lifecycle.archiveCurrent();
        return {
          success: true,
          message: 'session_archived',
          content: `Archived session \`${archived.sessionId}\`. Restore it with \`/unarchive ${archived.sessionId}\`.`,
          data: { session: archived },
        };
      }

      const sessionId = args[0]!;
      const resolved = await resolveUniqueSession(sessionId, false);
      if ('success' in resolved) return resolved;
      const archived = await SessionService.archiveSession(
        sessionId,
        resolved.projectPath
      );
      return {
        success: true,
        message: `Archived session ${sessionId}`,
        content: `Archived session \`${sessionId}\` and its inactive descendants. Restore it with \`/unarchive ${sessionId}\`.`,
        data: { session: archived },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive session',
      };
    }
  },
};

export const unarchiveCommand: SlashCommand = {
  name: 'unarchive',
  description: 'Restore an archived session tree to the active catalog',
  fullDescription:
    '恢复一个归档根会话及其继承归档状态的 fork/subagent 后代。单独归档的后代保持归档。',
  usage: '/unarchive <sessionId>',
  category: 'Session',
  examples: ['/unarchive web-abc123'],
  async handler(args): Promise<SlashCommandResult> {
    if (args.length !== 1) {
      return { success: false, error: 'Usage: /unarchive <sessionId>' };
    }
    try {
      const sessionId = args[0]!;
      const resolved = await resolveUniqueSession(sessionId, true);
      if ('success' in resolved) return resolved;
      const restored = await SessionService.unarchiveSession(
        sessionId,
        resolved.projectPath
      );
      return {
        success: true,
        message: `Restored session ${sessionId}`,
        content: `Restored session \`${sessionId}\` to the active catalog.`,
        data: { session: restored },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore session',
      };
    }
  },
};
