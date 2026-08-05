import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode } from '../../../src/config/types.js';
import {
  installWorkspaceSandboxBackendForTests,
  type WorkspaceSandboxBackend,
} from '../../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';
import { taskTool } from '../../../src/tools/builtin/task/task.js';
import { taskOutputTool } from '../../../src/tools/builtin/task/taskOutput.js';
import { isRealApiTestEnabled } from './testConfig.js';

const execFileAsync = promisify(execFile);
const shouldRun = isRealApiTestEnabled();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  return result.stdout.trim();
}

function parseWorktreePaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

describe.skipIf(!shouldRun)('Subagent Worktree Trajectory (Real API)', () => {
  let tempRoot = '';
  let repoRoot = '';
  let originalSource = '';
  let restoreSandboxBackend: (() => void) | undefined;
  let sandboxPreparations = 0;
  let previousStorageRoot: string | undefined;

  beforeAll(async () => {
    const testSandboxBackend: WorkspaceSandboxBackend = {
      async prepare(input) {
        sandboxPreparations++;
        return {
          executable: process.platform === 'win32' ? 'bash' : '/bin/bash',
          args: ['-c', input.command],
          env: {},
          sandboxed: true,
          cleanup: () => undefined,
        };
      },
    };
    restoreSandboxBackend = installWorkspaceSandboxBackendForTests(testSandboxBackend);

    tempRoot = await mkdtemp(join(os.tmpdir(), 'blade-subagent-trajectory-'));
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = join(tempRoot, 'storage');
    repoRoot = join(tempRoot, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await mkdir(join(repoRoot, 'test'), { recursive: true });
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'blade-subagent-worktree-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' },
        },
        null,
        2
      )
    );
    originalSource = [
      'export function clamp(value, min, max) {',
      '  return Math.max(max, Math.min(min, value));',
      '}',
      '',
    ].join('\n');
    await writeFile(join(repoRoot, 'src', 'clamp.js'), originalSource);
    await writeFile(
      join(repoRoot, 'test', 'clamp.test.js'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { clamp } from '../src/clamp.js';",
        '',
        "test('clamps values to the inclusive range', () => {",
        '  assert.equal(clamp(-5, 0, 10), 0);',
        '  assert.equal(clamp(5, 0, 10), 5);',
        '  assert.equal(clamp(15, 0, 10), 10);',
        '});',
        '',
      ].join('\n')
    );
    await git(repoRoot, 'init', '-b', 'main');
    await git(repoRoot, 'config', 'user.email', 'blade-test@example.com');
    await git(repoRoot, 'config', 'user.name', 'Blade Test');
    await git(repoRoot, 'add', '.');
    await git(repoRoot, 'commit', '-m', 'initial');

    subagentRegistry.clear();
    subagentRegistry.loadBuiltinAgents();
    subagentRegistry.register({
      name: 'worktree-writer',
      description: 'Focused coding agent for isolated implementation tasks',
      tools: ['Read', 'Glob', 'Edit', 'Bash'],
      systemPrompt:
        'You are a focused coding executor. Use tools immediately and complete ' +
        'the requested implementation end to end. Read every existing file before ' +
        'editing it. Make the smallest source change, run the exact requested test ' +
        'command, inspect its exit code, fix failures, and only then summarize evidence. ' +
        'Do not delegate, plan at length, or stop after analysis.',
    });
  });

  afterAll(async () => {
    (AgentSessionStore as unknown as { instance: unknown }).instance = null;
    (
      BackgroundAgentManager as unknown as {
        instance: unknown;
      }
    ).instance = null;
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    restoreSandboxBackend?.();
    if (repoRoot) {
      try {
        const canonicalRepoRoot = await realpath(repoRoot);
        const worktrees = parseWorktreePaths(
          await git(repoRoot, 'worktree', 'list', '--porcelain')
        ).filter((path) => path !== canonicalRepoRoot);
        for (const worktree of worktrees) {
          await git(repoRoot, 'worktree', 'remove', '--force', worktree);
        }
        const branches = await git(repoRoot, 'branch', '--list', 'blade-worktree-*');
        for (const branch of branches.split('\n').map((line) => line.trim())) {
          if (branch) await git(repoRoot, 'branch', '-D', branch);
        }
      } catch {
        // Best-effort cleanup for a temporary fixture.
      }
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('delegates a coding change into an isolated child worktree', async () => {
    const preparationsBefore = sandboxPreparations;
    const result = await taskTool
      .build({
        subagent_type: 'worktree-writer',
        description: 'Fix clamp implementation',
        prompt:
          'Work autonomously on this coding task. Inspect package.json, ' +
          'src/clamp.js, and test/clamp.test.js. Fix only src/clamp.js so all ' +
          'boundary cases pass. You must use Read before Edit, execute exactly ' +
          '"npm test" with Bash, inspect the exit code, and return a concise ' +
          'summary with test evidence. Do not merely explain the fix.',
        run_in_background: false,
        isolation: 'worktree',
        subagent_session_id: 'subagent-worktree-eval',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-worktree-eval',
        workspaceRoot: repoRoot,
        permissionMode: PermissionMode.YOLO,
      });

    expect(result.success).toBe(true);
    expect(sandboxPreparations).toBeGreaterThan(preparationsBefore);
    expect(await readFile(join(repoRoot, 'src', 'clamp.js'), 'utf-8')).toBe(
      originalSource
    );

    const canonicalRepoRoot = await realpath(repoRoot);
    const worktreePaths = parseWorktreePaths(
      await git(repoRoot, 'worktree', 'list', '--porcelain')
    ).filter((path) => path !== canonicalRepoRoot);
    expect(worktreePaths).toHaveLength(1);
    const childWorktree = worktreePaths[0];
    expect(await realpath(String(result.metadata?.worktreePath))).toBe(
      await realpath(childWorktree)
    );
    const childSource = await readFile(join(childWorktree, 'src', 'clamp.js'), 'utf-8');
    expect(childSource).not.toContain('Math.max(max, Math.min(min, value))');

    const verification = await execFileAsync(process.execPath, ['--test'], {
      cwd: childWorktree,
      timeout: 30_000,
    });
    expect(verification.stdout).toContain('pass 1');
  }, 300_000);

  it('persists a background worktree and restores it on resume', async () => {
    const preparationsBefore = sandboxPreparations;
    const agentId = 'background-worktree-eval';
    const started = await taskTool
      .build({
        subagent_type: 'worktree-writer',
        description: 'Fix clamp in background',
        prompt:
          'Inspect package.json, src/clamp.js, and test/clamp.test.js. Fix only ' +
          'src/clamp.js so all boundary cases pass. Use Read before Edit, run ' +
          'exactly "npm test" with Bash, inspect the exit code, and summarize evidence.',
        run_in_background: true,
        isolation: 'worktree',
        subagent_session_id: agentId,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-background-worktree-eval',
        workspaceRoot: repoRoot,
        permissionMode: PermissionMode.YOLO,
      });

    expect(started.success).toBe(true);
    const firstOutput = await taskOutputTool
      .build({
        task_id: agentId,
        block: true,
        timeout: 300_000,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-background-worktree-eval',
        workspaceRoot: repoRoot,
      });

    expect(firstOutput.success).toBe(true);
    expect(firstOutput.metadata?.status).toBe('completed');
    const firstWorktreePath = String(firstOutput.metadata?.worktree_path);
    expect(firstWorktreePath).not.toBe('undefined');
    expect(await readFile(join(repoRoot, 'src', 'clamp.js'), 'utf-8')).toBe(
      originalSource
    );
    expect(
      await readFile(join(firstWorktreePath, 'src', 'clamp.js'), 'utf-8')
    ).not.toContain('Math.max(max, Math.min(min, value))');

    const resumed = await taskTool
      .build({
        subagent_type: 'worktree-writer',
        description: 'Verify resumed worktree',
        prompt:
          'Continue in the existing workspace. Read src/clamp.js, run exactly ' +
          '"npm test" with Bash, inspect the exit code, and report the result. ' +
          'Do not change any files.',
        run_in_background: false,
        resume_from: agentId,
        subagent_session_id: 'resumed-worktree-eval',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-background-worktree-eval',
        workspaceRoot: repoRoot,
        permissionMode: PermissionMode.YOLO,
      });

    expect(resumed.success).toBe(true);
    expect(resumed.metadata).toMatchObject({
      subagentSessionId: 'resumed-worktree-eval',
      subagentResumedFrom: agentId,
      subagentRootId: agentId,
      subagentResumeDepth: 1,
      subagentStatus: 'completed',
    });
    const resumedOutput = await taskOutputTool
      .build({
        task_id: 'resumed-worktree-eval',
        block: true,
        timeout: 300_000,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-background-worktree-eval',
        workspaceRoot: repoRoot,
      });

    expect(resumedOutput.success).toBe(true);
    expect(resumedOutput.metadata?.status).toBe('completed');
    expect(sandboxPreparations).toBeGreaterThan(preparationsBefore);
    expect(await realpath(String(resumedOutput.metadata?.worktree_path))).toBe(
      await realpath(firstWorktreePath)
    );
    expect(resumedOutput.metadata).toMatchObject({
      resumed_from: agentId,
      root_agent_id: agentId,
      resume_depth: 1,
    });

    const sourceAfterResume = await taskOutputTool
      .build({
        task_id: agentId,
        block: false,
        timeout: 0,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-background-worktree-eval',
        workspaceRoot: repoRoot,
      });
    expect(sourceAfterResume.metadata).toMatchObject({
      status: 'completed',
      resume_depth: 0,
    });

    const verification = await execFileAsync(process.execPath, ['--test'], {
      cwd: firstWorktreePath,
      timeout: 30_000,
    });
    expect(verification.stdout).toContain('pass 1');
  }, 300_000);
});
