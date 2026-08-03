import path from 'node:path';
import { SessionService } from '../services/SessionService.js';
import type { SlashCommand } from './types.js';

const branchCommand: SlashCommand = {
  name: 'branch',
  description: 'Fork the current session into an independent branch',
  fullDescription: '将当前会话历史分支到一个独立会话',
  usage: '/branch',
  aliases: ['fork'],
  async handler(_args, context) {
    if (!context.sessionId) {
      return { success: false, error: 'No active session to branch' };
    }

    const projectPath = path.resolve(context.workspaceRoot ?? context.cwd);
    const fork = await SessionService.forkSession(context.sessionId, {
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    return {
      success: true,
      message: 'session_forked',
      content: context.acp
        ? `Created session branch ${fork.sessionId}. Load it with ACP session/load to continue independently.`
        : undefined,
      data: {
        action: 'restore_forked_session',
        sessionId: fork.sessionId,
        parentSessionId: fork.parentSessionId,
        messages: fork.messages,
        visibleMessages: SessionService.toUISafeMessages(fork.messages),
      },
    };
  },
};

export default branchCommand;
