import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { createWorktreeTools } from '../../src/tools/builtin/worktree/worktreeTools.js';
import {
  validateWorktreeName,
  WorktreeManager,
} from '../../src/worktree/WorktreeManager.js';
import { removeTestDirectory } from '../support/helpers/removeTestDirectory.js';

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

describe('WorktreeManager integration', () => {
  let tempRoot: string;
  let repoRoot: string;
  let sourceCwd: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(os.tmpdir(), 'blade-worktree-test-'));
    repoRoot = join(tempRoot, 'repo');
    sourceCwd = join(repoRoot, 'packages', 'demo');
    await mkdir(sourceCwd, { recursive: true });
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true }, null, 2)
    );
    await writeFile(join(sourceCwd, 'value.txt'), 'original\n');

    await git(repoRoot, 'init', '-b', 'main');
    await git(repoRoot, 'config', 'user.email', 'blade-test@example.com');
    await git(repoRoot, 'config', 'user.name', 'Blade Test');
    await git(repoRoot, 'add', '.');
    await git(repoRoot, 'commit', '-m', 'initial');

    manager = new WorktreeManager({
      storageRoot: join(tempRoot, 'storage'),
    });
  });

  afterEach(async () => {
    expect(manager.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
    await removeTestDirectory(tempRoot);
  });

  async function publishMainBranch(): Promise<void> {
    const remoteRoot = join(tempRoot, 'remote.git');
    await git(tempRoot, 'init', '--bare', remoteRoot);
    await git(repoRoot, 'remote', 'add', 'origin', remoteRoot);
    await git(repoRoot, 'push', '-u', 'origin', 'main');
  }

  async function makeStale(worktreeRoot: string): Promise<void> {
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(worktreeRoot, staleTime, staleTime);
  }

  it('rejects traversal and unsafe worktree names before side effects', () => {
    for (const name of ['', '.', '..', '../escape', '/absolute', 'bad name']) {
      expect(() => validateWorktreeName(name)).toThrow();
    }
    expect(() => validateWorktreeName('feature/api-v2')).not.toThrow();
  });

  it('creates an isolated worktree and preserves the source subdirectory', async () => {
    const session = await manager.enter({
      sessionId: 'session-a',
      workspaceRoot: sourceCwd,
      name: 'feature/api-v2',
    });

    expect(session.originalWorkspaceRoot).toBe(await realpath(sourceCwd));
    expect(session.workspaceRoot).toBe(join(session.worktreeRoot, 'packages/demo'));
    expect(session.branch).toMatch(/^blade-worktree-/);
    expect(session.sourceStateFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(session.workspaceRoot, 'value.txt'), 'utf-8')).toBe(
      'original\n'
    );

    await writeFile(join(session.workspaceRoot, 'value.txt'), 'isolated\n');
    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('original\n');

    const exited = await manager.exit({
      sessionId: 'session-a',
      action: 'keep',
    });
    expect(exited.workspaceRoot).toBe(await realpath(sourceCwd));
    expect(exited.removed).toBe(false);
    expect(await readFile(join(session.workspaceRoot, 'value.txt'), 'utf-8')).toBe(
      'isolated\n'
    );
    expect(manager.getActiveSession('session-a')).toBeUndefined();
  });

  it('summarizes tracked and untracked task artifacts against the base commit', async () => {
    const session = await manager.enter({
      sessionId: 'task-summary',
      workspaceRoot: sourceCwd,
      name: 'task/task-summary',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'updated\nsecond line\n');
    await writeFile(join(session.workspaceRoot, 'new-file.txt'), 'first\nsecond\n');

    await expect(manager.getChangeSummary(session.sessionId)).resolves.toEqual({
      changedFiles: 2,
      additions: 4,
      deletions: 1,
      commits: 0,
    });

    const artifact = await manager.getDiffArtifact(session.sessionId);
    expect(artifact).toMatchObject({
      baseCommit: session.baseCommit,
      truncated: false,
      files: [
        {
          path: 'packages/demo/new-file.txt',
          additions: 2,
          deletions: 0,
          binary: false,
          truncated: false,
        },
        {
          path: 'packages/demo/value.txt',
          additions: 2,
          deletions: 1,
          binary: false,
          truncated: false,
        },
      ],
    });
    expect(artifact?.files[0]?.patch).toContain('new file mode');
    expect(artifact?.files[0]?.patch).toContain('+first');
    expect(artifact?.files[1]?.patch).toContain('-original');
    expect(artifact?.files[1]?.patch).toContain('+updated');
  });

  it('applies committed and uncommitted task changes without committing the source', async () => {
    const session = await manager.enter({
      sessionId: 'task-apply',
      workspaceRoot: sourceCwd,
      name: 'task/task-apply',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'committed\n');
    await git(session.worktreeRoot, 'add', '.');
    await git(session.worktreeRoot, 'commit', '-m', 'task commit');
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'final\n');
    await writeFile(join(session.workspaceRoot, 'new-file.txt'), 'new\n');

    await expect(manager.getChangeSummary(session.sessionId)).resolves.toMatchObject({
      changedFiles: 2,
      commits: 1,
    });
    await expect(manager.apply(session.sessionId)).resolves.toMatchObject({
      action: 'apply',
      workspaceRoot: await realpath(sourceCwd),
      changedFiles: 2,
    });

    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('final\n');
    expect(await readFile(join(sourceCwd, 'new-file.txt'), 'utf-8')).toBe('new\n');
    expect(await git(repoRoot, 'rev-parse', 'HEAD')).toBe(session.baseCommit);
    expect(await git(repoRoot, 'status', '--porcelain')).toContain(
      'packages/demo/value.txt'
    );
  });

  it('applies over an unchanged dirty source state when patches do not overlap', async () => {
    await writeFile(join(repoRoot, 'local.txt'), 'user change\n');
    const session = await manager.enter({
      sessionId: 'task-dirty-source',
      workspaceRoot: sourceCwd,
      name: 'task/task-dirty-source',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'task change\n');

    await expect(manager.apply(session.sessionId)).resolves.toMatchObject({
      action: 'apply',
      changedFiles: 1,
    });
    expect(await readFile(join(repoRoot, 'local.txt'), 'utf-8')).toBe('user change\n');
    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('task change\n');
  });

  it('refuses delivery after the source state changes and preserves both workspaces', async () => {
    const session = await manager.enter({
      sessionId: 'task-source-drift',
      workspaceRoot: sourceCwd,
      name: 'task/task-source-drift',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'task change\n');
    await writeFile(join(repoRoot, 'local.txt'), 'later user change\n');

    const delivery = manager.apply(session.sessionId);
    await expect(delivery).rejects.toMatchObject({
      reason: 'source_state_changed',
    });
    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('original\n');
    expect(await readFile(join(session.workspaceRoot, 'value.txt'), 'utf-8')).toBe(
      'task change\n'
    );
    expect(await readFile(join(repoRoot, 'local.txt'), 'utf-8')).toBe(
      'later user change\n'
    );
  });

  it('preflights overlapping dirty-source changes without partial writes', async () => {
    await writeFile(join(sourceCwd, 'value.txt'), 'user change\n');
    const session = await manager.enter({
      sessionId: 'task-source-conflict',
      workspaceRoot: sourceCwd,
      name: 'task/task-source-conflict',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'task change\n');
    await writeFile(join(session.workspaceRoot, 'new-file.txt'), 'must not leak\n');

    await expect(manager.apply(session.sessionId)).rejects.toMatchObject({
      reason: 'patch_conflict',
    });
    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('user change\n');
    await expect(readFile(join(sourceCwd, 'new-file.txt'))).rejects.toThrow();
  });

  it('refuses delivery after the source branch advances', async () => {
    const session = await manager.enter({
      sessionId: 'task-head-drift',
      workspaceRoot: sourceCwd,
      name: 'task/task-head-drift',
    });
    await writeFile(join(session.workspaceRoot, 'value.txt'), 'task change\n');
    await writeFile(join(repoRoot, 'source.txt'), 'new source commit\n');
    await git(repoRoot, 'add', '.');
    await git(repoRoot, 'commit', '-m', 'advance source');

    await expect(manager.apply(session.sessionId)).rejects.toMatchObject({
      reason: 'source_head_changed',
    });
    expect(await readFile(join(sourceCwd, 'value.txt'), 'utf-8')).toBe('original\n');
  });

  it('refuses to remove dirty work unless discard_changes is explicit', async () => {
    const session = await manager.enter({
      sessionId: 'session-dirty',
      workspaceRoot: repoRoot,
      name: 'dirty',
    });
    await writeFile(join(session.worktreeRoot, 'dirty.txt'), 'unsaved\n');

    await expect(
      manager.exit({ sessionId: 'session-dirty', action: 'remove' })
    ).rejects.toThrow(/uncommitted/i);
    expect(manager.getActiveSession('session-dirty')).toBeDefined();

    const exited = await manager.exit({
      sessionId: 'session-dirty',
      action: 'remove',
      discardChanges: true,
    });
    expect(exited.removed).toBe(true);
    await expect(readFile(join(session.worktreeRoot, 'dirty.txt'))).rejects.toThrow();
  });

  it('refuses to remove commits that are not on the original HEAD', async () => {
    const session = await manager.enter({
      sessionId: 'session-commit',
      workspaceRoot: repoRoot,
      name: 'committed',
    });
    await writeFile(join(session.worktreeRoot, 'committed.txt'), 'work\n');
    await git(session.worktreeRoot, 'add', '.');
    await git(session.worktreeRoot, 'commit', '-m', 'worktree commit');

    await expect(
      manager.exit({ sessionId: 'session-commit', action: 'remove' })
    ).rejects.toThrow(/commit/i);
  });

  it('removes a clean worktree and its branch', async () => {
    const session = await manager.enter({
      sessionId: 'session-clean',
      workspaceRoot: repoRoot,
      name: 'clean',
    });

    const exited = await manager.exit({
      sessionId: 'session-clean',
      action: 'remove',
    });

    expect(exited.removed).toBe(true);
    expect(await git(repoRoot, 'branch', '--list', session.branch)).toBe('');
    expect(await git(repoRoot, 'worktree', 'list', '--porcelain')).not.toContain(
      session.worktreeRoot
    );
  });

  it('exposes workspace transition metadata through the builtin tools', async () => {
    const [enterTool, exitTool] = createWorktreeTools({
      sessionId: 'tool-session',
      manager,
    });
    const signal = new AbortController().signal;

    const entered = await enterTool.execute({ name: 'tool-flow' }, signal, {
      sessionId: 'tool-session',
      workspaceRoot: sourceCwd,
    });
    expect(entered.success).toBe(true);
    expect(entered.metadata).toEqual(
      expect.objectContaining({
        workspaceTransition: 'enter',
        workspaceRoot: expect.stringContaining('packages/demo'),
      })
    );

    const exited = await exitTool.execute(
      { action: 'keep', discard_changes: false },
      signal,
      {
        sessionId: 'tool-session',
        workspaceRoot: String(entered.metadata?.workspaceRoot),
      }
    );
    expect(exited.success).toBe(true);
    expect(exited.metadata).toEqual(
      expect.objectContaining({
        workspaceTransition: 'exit',
        workspaceRoot: await realpath(sourceCwd),
      })
    );
  });

  it('uses ExecutionContext.workspaceRoot as the default Bash cwd', async () => {
    const result = await bashTool
      .build({
        command: 'pwd',
        timeout: 30_000,
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        workspaceRoot: sourceCwd,
      });
    const content = result.llmContent as { stdout: string };

    expect(result.success).toBe(true);
    expect(await realpath(content.stdout)).toBe(await realpath(sourceCwd));
  });

  it('treats exit without a session as a no-op', async () => {
    const result = await manager.exit({
      sessionId: 'missing',
      action: 'remove',
      workspaceRoot: sourceCwd,
    });

    expect(result.noop).toBe(true);
    expect(result.workspaceRoot).toBe(sourceCwd);
    expect(await git(repoRoot, 'worktree', 'list', '--porcelain')).not.toContain(
      manager.getManagedRoot(repoRoot)
    );
  });

  it('treats cleanup outside a Git repository as a no-op', async () => {
    const nonGitRoot = join(tempRoot, 'non-git');
    await mkdir(nonGitRoot);

    const result = await manager.cleanupStaleAgentWorktrees({
      workspaceRoot: nonGitRoot,
    });

    expect(result).toEqual({
      scanned: 0,
      removed: 0,
      preserved: 0,
      skipped: 0,
      errors: [],
    });
  });

  it.each(['agent', 'task'] as const)(
    'removes stale clean %s worktrees after an interrupted process',
    async (kind) => {
      await publishMainBranch();
      const session = await manager.enter({
        sessionId: `${kind}-clean`,
        workspaceRoot: repoRoot,
        name: `${kind}/${kind}-clean`,
      });
      manager.releaseSession(session.sessionId);
      await makeStale(session.worktreeRoot);

      const result = await manager.cleanupStaleAgentWorktrees({
        workspaceRoot: repoRoot,
        maxAgeMs: 1_000,
      });

      expect(result.removed).toBe(1);
      expect(result.preserved).toBe(0);
      expect(result.errors).toEqual([]);
      await expect(access(session.worktreeRoot)).rejects.toThrow();
      expect(await git(repoRoot, 'branch', '--list', session.branch)).toBe('');
    }
  );

  it('preserves stale agent worktrees with dirty or unpushed work', async () => {
    await publishMainBranch();
    const dirty = await manager.enter({
      sessionId: 'agent-dirty',
      workspaceRoot: repoRoot,
      name: 'agent/agent-dirty',
    });
    await writeFile(join(dirty.worktreeRoot, 'untracked.txt'), 'valuable\n');
    manager.releaseSession(dirty.sessionId);
    await makeStale(dirty.worktreeRoot);

    const committed = await manager.enter({
      sessionId: 'agent-commit',
      workspaceRoot: repoRoot,
      name: 'agent/agent-commit',
    });
    await writeFile(join(committed.worktreeRoot, 'committed.txt'), 'valuable\n');
    await git(committed.worktreeRoot, 'add', '.');
    await git(committed.worktreeRoot, 'commit', '-m', 'local work');
    manager.releaseSession(committed.sessionId);
    await makeStale(committed.worktreeRoot);

    const result = await manager.cleanupStaleAgentWorktrees({
      workspaceRoot: repoRoot,
      maxAgeMs: 1_000,
    });

    expect(result.removed).toBe(0);
    expect(result.preserved).toBe(2);
    expect(result.errors).toEqual([]);
    expect(await readFile(join(dirty.worktreeRoot, 'untracked.txt'), 'utf-8')).toBe(
      'valuable\n'
    );
    expect(await readFile(join(committed.worktreeRoot, 'committed.txt'), 'utf-8')).toBe(
      'valuable\n'
    );
  });

  it('never sweeps user-named or currently active worktrees', async () => {
    await publishMainBranch();
    const userNamed = await manager.enter({
      sessionId: 'user-feature',
      workspaceRoot: repoRoot,
      name: 'feature/user-owned',
    });
    manager.releaseSession(userNamed.sessionId);
    await makeStale(userNamed.worktreeRoot);

    const active = await manager.enter({
      sessionId: 'agent-active',
      workspaceRoot: repoRoot,
      name: 'agent/agent-active',
    });
    await makeStale(active.worktreeRoot);

    const result = await manager.cleanupStaleAgentWorktrees({
      workspaceRoot: repoRoot,
      maxAgeMs: 1_000,
    });

    expect(result.removed).toBe(0);
    expect(result.preserved).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    await expect(access(userNamed.worktreeRoot)).resolves.toBeUndefined();
    await expect(access(active.worktreeRoot)).resolves.toBeUndefined();
  });

  it('preserves stale directories when Git identity cannot be verified', async () => {
    const invalidRoot = join(
      manager.getManagedRoot(await realpath(repoRoot)),
      'agent+invalid-state'
    );
    await mkdir(invalidRoot, { recursive: true });
    await makeStale(invalidRoot);

    const result = await manager.cleanupStaleAgentWorktrees({
      workspaceRoot: repoRoot,
      maxAgeMs: 1_000,
    });

    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Git inspection failed');
    await expect(access(invalidRoot)).resolves.toBeUndefined();
  });

  it('does not retain historical Session locks after no-op exits', async () => {
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        manager.exit({
          sessionId: `historical-${index}`,
          action: 'keep',
        })
      )
    );

    expect(manager.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
  });
});
