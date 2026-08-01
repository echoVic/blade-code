import type {
  WorktreeChangeSummary,
  WorktreeSession,
} from '../../worktree/WorktreeManager.js';
import {
  type WorktreeManager,
  worktreeManager,
} from '../../worktree/WorktreeManager.js';

export type SubagentIsolationMode = 'none' | 'worktree';

export interface SubagentWorktreeLease {
  isolation: SubagentIsolationMode;
  workspaceRoot: string;
  worktree?: WorktreeSession;
}

export interface SubagentWorktreeOutcome {
  preserved: boolean;
  removed: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  worktree?: WorktreeSession;
  changedFiles?: number;
  commits?: number;
}

interface PrepareInput {
  agentId: string;
  sourceWorkspaceRoot: string;
  isolation?: SubagentIsolationMode;
  restoredWorktree?: WorktreeSession;
}

interface FinalizeInput {
  agentId: string;
  lease: SubagentWorktreeLease;
  success: boolean;
}

function agentWorktreeName(agentId: string): string {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `agent/${safeId || 'anonymous'}`;
}

export class SubagentWorktreeLifecycle {
  constructor(private readonly manager: WorktreeManager = worktreeManager) {}

  async prepare(input: PrepareInput): Promise<SubagentWorktreeLease> {
    const isolation = input.isolation ?? 'none';
    if (isolation !== 'worktree') {
      return {
        isolation: 'none',
        workspaceRoot: input.sourceWorkspaceRoot,
      };
    }

    const worktree = input.restoredWorktree
      ? await this.manager.restoreSession(input.restoredWorktree)
      : await this.manager.enter({
          sessionId: input.agentId,
          workspaceRoot: input.sourceWorkspaceRoot,
          name: agentWorktreeName(input.agentId),
        });

    return {
      isolation,
      workspaceRoot: worktree.workspaceRoot,
      worktree,
    };
  }

  async finalize(input: FinalizeInput): Promise<SubagentWorktreeOutcome> {
    const { worktree } = input.lease;
    if (!worktree) {
      return { preserved: false, removed: false };
    }

    const summary = await this.manager.getChangeSummary(input.agentId);
    if (input.success && this.isClean(summary)) {
      await this.manager.exit({
        sessionId: input.agentId,
        action: 'remove',
      });
      return {
        preserved: false,
        removed: true,
        changedFiles: 0,
        commits: 0,
      };
    }

    await this.manager.exit({
      sessionId: input.agentId,
      action: 'keep',
    });
    return {
      preserved: true,
      removed: false,
      worktreePath: worktree.worktreeRoot,
      worktreeBranch: worktree.branch,
      worktree,
      changedFiles: summary?.changedFiles,
      commits: summary?.commits,
    };
  }

  private isClean(
    summary: WorktreeChangeSummary | null | undefined
  ): summary is WorktreeChangeSummary {
    return (
      summary !== null &&
      summary !== undefined &&
      summary.changedFiles === 0 &&
      summary.commits === 0
    );
  }
}

export const subagentWorktreeLifecycle = new SubagentWorktreeLifecycle();
