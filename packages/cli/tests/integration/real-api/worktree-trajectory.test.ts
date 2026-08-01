import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'pathe';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
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

describe.skipIf(!shouldRun)('Worktree Agent Trajectory (Real API)', () => {
  let tempRoot = '';
  let repoRoot = '';
  let originalSource = '';

  beforeAll(async () => {
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
  });

  afterAll(async () => {
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
});
