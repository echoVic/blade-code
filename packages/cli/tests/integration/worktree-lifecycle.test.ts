import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'pathe';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateWorktreeName,
  WorktreeManager,
} from '../../src/worktree/WorktreeManager.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { createWorktreeTools } from '../../src/tools/builtin/worktree/worktreeTools.js';

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
    await rm(tempRoot, { recursive: true, force: true });
  });

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
});
