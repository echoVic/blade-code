import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentWorktreeLifecycle } from '../../src/agent/subagents/SubagentWorktreeLifecycle.js';
import { WorktreeManager } from '../../src/worktree/WorktreeManager.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  return result.stdout.trim();
}

describe('SubagentWorktreeLifecycle integration', () => {
  let tempRoot: string;
  let repoRoot: string;
  let manager: WorktreeManager;
  let lifecycle: SubagentWorktreeLifecycle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(os.tmpdir(), 'blade-subagent-worktree-'));
    repoRoot = join(tempRoot, 'repo');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'value.txt'), 'parent\n');
    await git(repoRoot, 'init', '-b', 'main');
    await git(repoRoot, 'config', 'user.email', 'blade-test@example.com');
    await git(repoRoot, 'config', 'user.name', 'Blade Test');
    await git(repoRoot, 'add', '.');
    await git(repoRoot, 'commit', '-m', 'initial');

    manager = new WorktreeManager({
      storageRoot: join(tempRoot, 'storage'),
    });
    lifecycle = new SubagentWorktreeLifecycle(manager);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('removes a successful isolated workspace when no changes were made', async () => {
    const lease = await lifecycle.prepare({
      agentId: 'agent-clean',
      sourceWorkspaceRoot: repoRoot,
      isolation: 'worktree',
    });

    const outcome = await lifecycle.finalize({
      agentId: 'agent-clean',
      lease,
      success: true,
    });

    expect(outcome.preserved).toBe(false);
    expect(outcome.worktreePath).toBeUndefined();
    expect(await git(repoRoot, 'worktree', 'list', '--porcelain')).not.toContain(
      lease.worktree?.worktreeRoot
    );
  });

  it('preserves changed child work and leaves the parent checkout unchanged', async () => {
    const lease = await lifecycle.prepare({
      agentId: 'agent-changed',
      sourceWorkspaceRoot: repoRoot,
      isolation: 'worktree',
    });
    await writeFile(join(lease.workspaceRoot, 'value.txt'), 'child\n');

    const outcome = await lifecycle.finalize({
      agentId: 'agent-changed',
      lease,
      success: true,
    });

    expect(outcome.preserved).toBe(true);
    expect(outcome.worktreePath).toBe(lease.worktree?.worktreeRoot);
    expect(outcome.changedFiles).toBe(1);
    expect(await readFile(join(repoRoot, 'value.txt'), 'utf-8')).toBe('parent\n');
    expect(await readFile(join(lease.workspaceRoot, 'value.txt'), 'utf-8')).toBe(
      'child\n'
    );
  });

  it('preserves a failed child workspace even when it is clean', async () => {
    const lease = await lifecycle.prepare({
      agentId: 'agent-failed',
      sourceWorkspaceRoot: repoRoot,
      isolation: 'worktree',
    });

    const outcome = await lifecycle.finalize({
      agentId: 'agent-failed',
      lease,
      success: false,
    });

    expect(outcome.preserved).toBe(true);
    expect(outcome.worktreePath).toBe(lease.worktree?.worktreeRoot);
  });

  it('restores a persisted worktree lease for subagent resume', async () => {
    const firstLease = await lifecycle.prepare({
      agentId: 'agent-resume',
      sourceWorkspaceRoot: repoRoot,
      isolation: 'worktree',
    });
    await writeFile(join(firstLease.workspaceRoot, 'resume.txt'), 'state\n');
    await lifecycle.finalize({
      agentId: 'agent-resume',
      lease: firstLease,
      success: true,
    });

    const resumed = await lifecycle.prepare({
      agentId: 'agent-resumed-child',
      sourceWorkspaceRoot: repoRoot,
      isolation: 'worktree',
      restoredWorktree: firstLease.worktree,
    });

    expect(await realpath(resumed.workspaceRoot)).toBe(
      await realpath(firstLease.workspaceRoot)
    );
    expect(await readFile(join(resumed.workspaceRoot, 'resume.txt'), 'utf-8')).toBe(
      'state\n'
    );
    expect(resumed.ownerAgentId).toBe('agent-resume');

    const outcome = await lifecycle.finalize({
      agentId: 'agent-resumed-child',
      lease: resumed,
      success: false,
    });
    expect(outcome.preserved).toBe(true);
  });
});
