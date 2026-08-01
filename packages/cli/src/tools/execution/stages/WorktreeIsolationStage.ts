import type { PipelineStage, ToolExecution } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

export class WorktreeIsolationStage implements PipelineStage {
  readonly name = 'worktree-isolation';

  async process(execution: ToolExecution): Promise<void> {
    const { tool } = execution._internal;
    if (
      !tool ||
      !execution.context.worktreeIsolationRequired ||
      execution.context.worktreeActive ||
      execution.toolName === 'EnterWorktree' ||
      tool.kind === ToolKind.ReadOnly
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
}
