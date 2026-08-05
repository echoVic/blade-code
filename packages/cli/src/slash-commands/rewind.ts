import path from 'node:path';
import { SessionService } from '../services/SessionService.js';
import { getState } from '../store/vanilla.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { SnapshotManager } from '../tools/builtin/file/SnapshotManager.js';
import { PathSecurity } from '../utils/pathSecurity.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

async function handleFileRewind(
  pathArgs: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const sessionId = context.sessionId ?? getState().session?.sessionId;
  if (!sessionId) {
    ui.sendMessage('No active session is available for file rewind.');
    return { success: false, error: 'No active session' };
  }
  if (pathArgs.length === 0) {
    return {
      success: false,
      error: 'Usage: /rewind file <file_path>',
    };
  }

  const workspaceRoot = path.resolve(context.workspaceRoot ?? context.cwd);
  const targetPath = path.resolve(context.cwd, pathArgs.join(' '));
  if (!(await PathSecurity.isWithinWorkspaceResolved(targetPath, workspaceRoot))) {
    const error = `Target path is outside the current workspace: ${targetPath}`;
    ui.sendMessage(error);
    return { success: false, error };
  }

  const snapshotManager = new SnapshotManager({
    sessionId,
    workspaceRoot,
  });
  await snapshotManager.initialize();
  const restored = await snapshotManager.rewindLatest(targetPath);
  FileAccessTracker.getInstance().clearFileRecord(restored.filePath);
  const displayPath = path.relative(workspaceRoot, targetPath) || '.';
  ui.sendMessage(
    `Rewound \`${displayPath}\` to the state before the latest Blade edit (v${restored.version}).`
  );
  return { success: true };
}

function parseTurnRewindArgs(args: string[]): {
  targetMessageId: string;
  mode: 'conversation' | 'code' | 'both';
} {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const targets = args.filter((arg) => !arg.startsWith('--'));
  const knownFlags = new Set(['--code', '--code-only', '--conversation']);
  const unknownFlag = [...flags].find((flag) => !knownFlags.has(flag));
  if (unknownFlag) throw new Error(`Unknown rewind option: ${unknownFlag}`);
  if (targets.length !== 1) {
    throw new Error(
      'Usage: /rewind <checkpointId> [--code|--code-only|--conversation]'
    );
  }
  if (flags.has('--code') && flags.has('--code-only')) {
    throw new Error('--code and --code-only cannot be combined');
  }
  return {
    targetMessageId: targets[0]!,
    mode: flags.has('--code-only')
      ? 'code'
      : flags.has('--code')
        ? 'both'
        : 'conversation',
  };
}

const rewindCommand: SlashCommand = {
  name: 'rewind',
  description: 'Rewind the conversation and optionally restore code',
  fullDescription:
    'List durable user-turn checkpoints or rewind to one. Use --code to restore both conversation and code. Legacy single-file rewind remains available through /rewind file <path>.',
  usage: '/rewind [checkpointId] [--code|--code-only] | /rewind file <file_path>',
  aliases: ['undo', 'checkpoint'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    try {
      if (args[0] === 'file' || args[0] === '--file') {
        return await handleFileRewind(args.slice(1), context);
      }
      if (!context.rewind) {
        return {
          success: false,
          error: 'This surface does not own a session runtime for rewind',
        };
      }
      if (args.length === 0) {
        const checkpoints = await context.rewind.listCheckpoints();
        if (checkpoints.length === 0) {
          ui.sendMessage('Nothing to rewind to yet.');
          return { success: true };
        }
        const lines = checkpoints.map((checkpoint) => {
          const files =
            checkpoint.fileCount === 0
              ? ''
              : `, ${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? '' : 's'}`;
          return `- \`${checkpoint.messageId}\` ${checkpoint.preview}${files}`;
        });
        ui.sendMessage(
          [
            '**Rewind checkpoints**',
            '',
            ...lines,
            '',
            'Use `/rewind <checkpointId>` for conversation only or add `--code` to restore code too.',
          ].join('\n')
        );
        return { success: true };
      }

      const options = parseTurnRewindArgs(args);
      const result = await context.rewind.execute(options);
      const visibleMessages = SessionService.toUISafeMessages(result.messages);
      const restored =
        result.restoredFiles.length === 0
          ? ''
          : ` Restored ${result.restoredFiles.length} file${result.restoredFiles.length === 1 ? '' : 's'}.`;
      ui.sendMessage(
        `Rewound ${result.removedTurns} turn${result.removedTurns === 1 ? '' : 's'} to before: ${result.checkpoint.preview}.${restored}`
      );
      return {
        success: true,
        data: {
          action: 'rewind_session',
          sessionId: context.sessionId,
          messages: result.messages,
          visibleMessages,
          checkpoint: result.checkpoint,
          mode: result.mode,
          restoredFiles: result.restoredFiles,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.sendMessage(`Rewind failed: ${message}`);
      return { success: false, error: message };
    }
  },
};

export default rewindCommand;
