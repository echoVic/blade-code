import { PathSecurity } from '../../../utils/pathSecurity.js';
import type { PipelineStage, ToolExecution } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

export class WorktreeIsolationStage implements PipelineStage {
  readonly name = 'worktree-isolation';

  async process(execution: ToolExecution): Promise<void> {
    const { tool } = execution._internal;
    if (!tool) {
      return;
    }

    if (execution.context.worktreeActive) {
      await this.enforceActiveWorktreeBoundary(execution);
      return;
    }

    const isolatedTask =
      execution.toolName === 'Task' && execution.params.isolation === 'worktree';
    if (
      !execution.context.worktreeIsolationRequired ||
      execution.toolName === 'EnterWorktree' ||
      isolatedTask ||
      (tool.kind === ToolKind.ReadOnly && execution.toolName !== 'Task')
    ) {
      return;
    }

    execution.abort(
      'Blocked side-effecting tool outside the explicitly required worktree',
      {
        llmContent:
          'Worktree isolation is required. Call EnterWorktree and wait for it ' +
          'to succeed before using any write or execute tool.',
        summary: 'Blocked until EnterWorktree succeeds',
        errorType: ToolErrorType.PERMISSION_DENIED,
      }
    );
  }

  private async enforceActiveWorktreeBoundary(execution: ToolExecution): Promise<void> {
    const tool = execution._internal.tool;
    if (!tool) return;

    const pathKeys =
      tool.kind === ToolKind.Write
        ? (['file_path', 'notebook_path', 'path'] as const)
        : execution.toolName === 'Bash'
          ? (['cwd'] as const)
          : [];
    const targets = pathKeys
      .map((key) => execution.params[key])
      .filter((value): value is string => typeof value === 'string');

    if (targets.length === 0) {
      return;
    }

    const workspaceRoot = execution.context.workspaceRoot;
    if (!workspaceRoot) {
      this.abortOutsideWorktree(execution, targets[0], 'workspace root is missing');
      return;
    }

    for (const target of targets) {
      if (!(await PathSecurity.isWithinWorkspaceResolved(target, workspaceRoot))) {
        this.abortOutsideWorktree(execution, target);
        return;
      }
    }
  }

  private abortOutsideWorktree(
    execution: ToolExecution,
    target: string,
    detail?: string
  ): void {
    const suffix = detail ? ` (${detail})` : '';
    execution.abort(`Blocked path outside the active worktree: ${target}${suffix}`, {
      llmContent:
        `The requested path "${target}" is outside the active worktree. ` +
        'Use a path under the current workspace root.',
      summary: 'Blocked path outside active worktree',
      errorType: ToolErrorType.PERMISSION_DENIED,
    });
  }
}
