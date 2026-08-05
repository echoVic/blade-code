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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import {
  installWorkspaceSandboxBackendForTests,
  type WorkspaceSandboxBackend,
} from '../../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { WorktreeManager } from '../../../src/worktree/WorktreeManager.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const shouldRun = isRealApiTestEnabled();
const taskModelConfigs = shouldRun
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true }).filter(
      (config) =>
        config.id === 'deepseek' &&
        ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(config.model)
    )
  : [];

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

describe.skipIf(!shouldRun)('Worktree Agent Trajectory (Real API)', () => {
  let tempRoot = '';
  let repoRoot = '';
  let originalSource = '';
  let restoreSandboxBackend: (() => void) | undefined;
  let sandboxPreparations = 0;
  let originalConfig: RuntimeConfig | null = null;

  beforeAll(async () => {
    originalConfig = getState().config.config;
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

    tempRoot = await mkdtemp(join(os.tmpdir(), 'blade-worktree-trajectory-'));
    repoRoot = join(tempRoot, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await mkdir(join(repoRoot, 'test'), { recursive: true });

    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'blade-worktree-trajectory-fixture',
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
    const remoteRoot = join(tempRoot, 'remote.git');
    await git(tempRoot, 'init', '--bare', remoteRoot);
    await git(repoRoot, 'remote', 'add', 'origin', remoteRoot);
    await git(repoRoot, 'push', '-u', 'origin', 'main');
  });

  afterAll(async () => {
    restoreSandboxBackend?.();
    if (originalConfig) {
      getState().config.actions.setConfig(originalConfig);
    }
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
          if (branch) {
            await git(repoRoot, 'branch', '-D', branch);
          }
        }
      } catch {
        // Best-effort cleanup; the temporary repository is removed below.
      }
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('edits and verifies only inside a managed worktree', async () => {
    const preparationsBefore = sandboxPreparations;
    const orphanManager = new WorktreeManager();
    const orphan = await orphanManager.enter({
      sessionId: 'real-api-orphan',
      workspaceRoot: repoRoot,
      name: 'agent/real-api-orphan',
    });
    orphanManager.releaseSession(orphan.sessionId);
    const staleTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000);
    await utimes(orphan.worktreeRoot, staleTime, staleTime);

    let output = '';
    const stdout = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    };
    const stderr = {
      write(_chunk: string) {
        return true;
      },
    };

    const exitCode = await runWithCwdOverride(repoRoot, () =>
      runHeadless(
        {
          headless: true,
          outputFormat: 'jsonl',
          maxTurns: 16,
          allowedTools: [
            'EnterWorktree',
            'ExitWorktree',
            'Read',
            'Edit',
            'Glob',
            'Grep',
            'Bash',
          ],
          appendSystemPrompt:
            'The user explicitly requires worktree isolation. First call ' +
            'EnterWorktree with name "blade-eval". Wait for its result. Make ' +
            'all edits and run exactly "npm test" inside that worktree. Finally ' +
            'call ExitWorktree with action "keep". Never edit the original workspace.',
          message:
            'Use a git worktree named blade-eval to fix the failing clamp ' +
            'implementation. Run npm test in the worktree, then exit the ' +
            'worktree with action keep. Do not modify the original checkout.',
        },
        { stdout, stderr }
      )
    );

    const events = output
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
    const toolNames = events
      .filter((event) => event.type === 'tool_start')
      .map((event) => event.tool_name);

    expect(exitCode).toBe(0);
    expect(sandboxPreparations).toBeGreaterThan(preparationsBefore);
    await expect(access(orphan.worktreeRoot)).rejects.toThrow();
    expect(toolNames).toContain('EnterWorktree');
    expect(toolNames.some((name) => name === 'Edit' || name === 'Write')).toBe(true);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('ExitWorktree');
    expect(await readFile(join(repoRoot, 'src', 'clamp.js'), 'utf-8')).toBe(
      originalSource
    );

    const canonicalRepoRoot = await realpath(repoRoot);
    const worktreePaths = parseWorktreePaths(
      await git(repoRoot, 'worktree', 'list', '--porcelain')
    ).filter((path) => path !== canonicalRepoRoot);
    expect(worktreePaths).toHaveLength(1);
    const worktreeRoot = worktreePaths[0];
    const isolatedSource = await readFile(
      join(worktreeRoot, 'src', 'clamp.js'),
      'utf-8'
    );
    expect(isolatedSource).not.toContain('Math.max(max, Math.min(min, value))');

    const verification = await execFileAsync(process.execPath, ['--test'], {
      cwd: worktreeRoot,
      timeout: 30_000,
    });
    expect(verification.stdout).toContain('pass 1');
  }, 300_000);

  for (const modelConfig of taskModelConfigs) {
    it(`${modelConfig.model} dispatches the headless task directly into a durable worktree`, async () => {
      getState().config.actions.setConfig(buildRealApiRuntimeConfig(modelConfig));
      let output = '';
      let diagnostics = '';
      const stdout = {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      };
      const stderr = {
        write(chunk: string) {
          diagnostics += chunk;
          return true;
        },
      };

      const exitCode = await runWithCwdOverride(repoRoot, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            permissionMode: 'yolo',
            taskIsolation: 'worktree',
            maxTurns: 12,
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
            appendSystemPrompt: [
              'You are already running inside the isolated task workspace.',
              'Do not create or enter another worktree.',
              'Read src/clamp.js and test/clamp.test.js.',
              'Fix only src/clamp.js, run exactly "npm test", and finish only after it passes.',
            ].join(' '),
            message:
              'Fix the clamp implementation and verify it with the existing test suite.',
          },
          { stdout, stderr }
        )
      );

      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const taskSession = events.find((event) => event.type === 'task_session');
      if (!taskSession || taskSession.type !== 'task_session') {
        throw new Error('Headless task_session event is missing');
      }
      const toolNames = events
        .filter((event) => event.type === 'tool_start')
        .map((event) => event.tool_name);

      expect(exitCode, diagnostics).toBe(0);
      expect(taskSession.source_project_path).toBe(repoRoot);
      expect(taskSession.project_path).not.toBe(repoRoot);
      expect(taskSession.isolation).toBe('worktree');
      expect(taskSession.worktree_branch).toMatch(/^blade-worktree-task\+/);
      expect(taskSession.base_commit).toMatch(/^[a-f0-9]{40}$/);
      expect(toolNames.some((name) => name === 'Edit' || name === 'Write')).toBe(true);
      expect(toolNames).toContain('Bash');
      expect(toolNames).not.toContain('EnterWorktree');
      expect(toolNames).not.toContain('ExitWorktree');
      expect(await readFile(join(repoRoot, 'src', 'clamp.js'), 'utf-8')).toBe(
        originalSource
      );

      const isolatedSource = await readFile(
        join(taskSession.project_path, 'src', 'clamp.js'),
        'utf-8'
      );
      expect(isolatedSource).not.toContain('Math.max(max, Math.min(min, value))');
      const verification = await execFileAsync(process.execPath, ['--test'], {
        cwd: taskSession.project_path,
        timeout: 30_000,
      });
      expect(verification.stdout).toContain('pass 1');

      const metadata = await SessionService.findSessionMetadata(
        taskSession.session_id,
        taskSession.project_path
      );
      expect(metadata).toMatchObject({
        taskStatus: 'completed',
        taskIsolation: 'worktree',
        taskSourceProjectPath: repoRoot,
        taskWorktreePath: taskSession.project_path,
        taskWorktreeBranch: taskSession.worktree_branch,
        taskBaseCommit: taskSession.base_commit,
        taskDiffStat: {
          changedFiles: 1,
          commits: 0,
        },
      });
      expect(metadata?.taskDiffStat?.additions).toBeGreaterThan(0);
      expect(metadata?.taskDiffStat?.deletions).toBeGreaterThan(0);
      assertNoSecrets({ output, diagnostics, metadata }, [modelConfig.apiKey]);
    }, 360_000);
  }
});
