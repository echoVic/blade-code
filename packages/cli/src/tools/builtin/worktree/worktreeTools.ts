import { Default, StringEnum, Type } from '../../../schema/index.js';
import { getCwd } from '../../../utils/cwd.js';
import {
  type WorktreeManager,
  worktreeManager,
} from '../../../worktree/WorktreeManager.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

interface WorktreeToolOptions {
  sessionId: string;
  manager?: WorktreeManager;
}

function failure(message: string): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
    },
    metadata: {
      summary: message,
    },
  };
}

export function createWorktreeTools(options: WorktreeToolOptions) {
  const manager = options.manager ?? worktreeManager;

  const enterWorktreeTool = createTool({
    name: 'EnterWorktree',
    displayName: 'Enter Worktree',
    kind: ToolKind.Execute,
    isConcurrencySafe: false,
    strict: true,
    schema: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            'Optional worktree name. Use letters, digits, dots, underscores, dashes, and optional "/" separators.',
        })
      ),
    }),
    description: {
      short: 'Create an isolated git worktree and switch this session into it',
      long:
        'Use only when the user explicitly asks to work in a git worktree. ' +
        'The worktree starts from committed HEAD; uncommitted source changes remain in the original workspace.',
      usageNotes: [
        'Do not combine EnterWorktree with file or Bash tools in the same response',
        'Wait for the worktree path, then use that path for all subsequent operations',
        'Use ExitWorktree when the user asks to leave, keep, or remove the worktree',
      ],
      important: [
        'Never enter a worktree unless the user explicitly requested worktree isolation',
        'A session can have only one active managed worktree',
      ],
    },
    async execute(params, context) {
      try {
        const sessionId = context.sessionId ?? options.sessionId;
        const session = await manager.enter({
          sessionId,
          workspaceRoot: context.workspaceRoot ?? getCwd(),
          name: params.name,
        });
        const sourceWarning = session.sourceHadChanges
          ? ' The original workspace has uncommitted changes; they were not copied.'
          : '';
        const message =
          `Created worktree ${session.worktreeRoot} on branch ${session.branch}. ` +
          `This session now uses ${session.workspaceRoot}.${sourceWarning}`;

        return {
          success: true,
          llmContent: message,
          metadata: {
            summary: `Entered worktree ${session.name}`,
            workspaceTransition: 'enter',
            workspaceRoot: session.workspaceRoot,
            worktreeRoot: session.worktreeRoot,
            worktreeBranch: session.branch,
            originalWorkspaceRoot: session.originalWorkspaceRoot,
            sourceHadChanges: session.sourceHadChanges,
          },
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
    version: '1.0.0',
    category: '工作区工具',
    tags: ['git', 'worktree', 'isolation'],
    extractSignatureContent: (params) => params.name ?? 'auto',
    abstractPermissionRule: () => '*',
  });

  const exitWorktreeTool = createTool({
    name: 'ExitWorktree',
    displayName: 'Exit Worktree',
    kind: ToolKind.Execute,
    isConcurrencySafe: false,
    strict: true,
    schema: Type.Object({
      action: StringEnum(['keep', 'remove'], {
        description:
          '"keep" preserves the worktree and branch; "remove" deletes both when safe.',
      }),
      discard_changes: Default(
        Type.Boolean({
          description:
            'Required true to remove a worktree with uncommitted files or unmerged commits.',
        }),
        false
      ),
    }),
    description: {
      short: 'Exit the managed worktree for this session',
      long:
        'Only affects a worktree created by EnterWorktree in the same session. ' +
        'Manual or unrelated worktrees are never touched.',
      usageNotes: [
        'Use action="keep" to preserve work for later',
        'Use action="remove" only when the worktree is clean',
        'If removal is refused, ask the user before retrying with discard_changes=true',
      ],
      important: [
        'Never set discard_changes=true without explicit user confirmation',
        'Removal fails closed when Git state cannot be verified',
      ],
    },
    async execute(params, context) {
      try {
        const sessionId = context.sessionId ?? options.sessionId;
        const result = await manager.exit({
          sessionId,
          action: params.action,
          discardChanges: params.discard_changes,
          workspaceRoot: context.workspaceRoot ?? getCwd(),
        });
        if (result.noop) {
          return {
            success: true,
            llmContent:
              'No active managed worktree exists for this session. No files were changed.',
            metadata: {
              summary: 'No active worktree',
              noop: true,
            },
          };
        }

        const message =
          result.action === 'keep'
            ? `Exited worktree and preserved it at ${result.worktreeRoot} on branch ${result.branch}. Session workspace restored to ${result.workspaceRoot}.`
            : `Exited and removed worktree ${result.worktreeRoot}. Session workspace restored to ${result.workspaceRoot}.`;
        return {
          success: true,
          llmContent: message,
          metadata: {
            summary:
              result.action === 'keep'
                ? `Kept worktree ${result.branch}`
                : `Removed worktree ${result.branch}`,
            workspaceTransition: 'exit',
            workspaceRoot: result.workspaceRoot,
            worktreeRoot: result.worktreeRoot,
            worktreeBranch: result.branch,
            removed: result.removed,
            discardedFiles: result.discardedFiles,
            discardedCommits: result.discardedCommits,
          },
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
    version: '1.0.0',
    category: '工作区工具',
    tags: ['git', 'worktree', 'isolation'],
    extractSignatureContent: (params) =>
      `${params.action}${params.discard_changes ? ':discard' : ''}`,
    abstractPermissionRule: (params) => params.action,
  });

  return [enterWorktreeTool, exitWorktreeTool] as const;
}
