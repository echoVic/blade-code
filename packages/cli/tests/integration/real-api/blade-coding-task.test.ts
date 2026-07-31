import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from './codingTaskHarness.js';
import { isRealApiTestEnabled } from './testConfig.js';

const cliEntry = path.resolve('dist', 'blade.js');
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const models = (process.env.DEEPSEEK_MODELS ?? 'deepseek-v4-flash,deepseek-v4-pro')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

let realSpawn: typeof spawn;

beforeAll(async () => {
  const childProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  realSpawn = childProcess.spawn;
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Blade Test',
      GIT_AUTHOR_EMAIL: 'blade-test@example.invalid',
      GIT_COMMITTER_NAME: 'Blade Test',
      GIT_COMMITTER_EMAIL: 'blade-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function createCodingTaskWorkspace(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-task-'));
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(path.join(workspace, 'test'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'blade-real-api-task',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(workspace, 'src', 'math.js'),
    'export function add(left, right) {\n  return left - right;\n}\n'
  );
  writeFileSync(
    path.join(workspace, 'test', 'math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      '',
      "test('add returns the sum', () => {",
      '  assert.equal(add(2, 3), 5);',
      '  assert.equal(add(-2, 3), 1);',
      '});',
      '',
    ].join('\n')
  );

  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '.']);
  runGit(workspace, ['commit', '-qm', 'fixture']);
  return workspace;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface BladeInvocationOptions {
  prompt: string;
  maxTurns?: number;
  sessionId?: string;
  permissionMode?: 'plan' | 'yolo';
}

function runBladeInvocation(
  workspace: string,
  home: string,
  model: string,
  options: BladeInvocationOptions
): Promise<CommandResult> {
  const configDir = path.join(home, '.blade');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(buildRealApiConfig({ modelId: model, model, baseUrl }), null, 2)
  );

  const args = [
    cliEntry,
    '--headless',
    '--output-format',
    'jsonl',
    '--permission-mode',
    options.permissionMode ?? 'yolo',
    '--max-turns',
    String(options.maxTurns ?? 12),
    '--model',
    model,
  ];
  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  args.push(options.prompt);

  return new Promise((resolve) => {
    const child = realSpawn('node', args, {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        BLADE_API_KEY: apiKey,
        BLADE_TELEMETRY_DISABLED: '1',
        BLADE_ALLOW_ROOT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 240_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: null, stdout, stderr, error });
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({
        status,
        stdout,
        stderr,
        error: timedOut
          ? new Error('Blade CLI timed out after 240 seconds')
          : undefined,
      });
    });
  });
}

function createCodingTaskPrompt(): string {
  return [
    'Work on this repository as a coding agent.',
    'Inspect src/math.js and the existing tests before editing.',
    'Fix the implementation bug so add(left, right) returns the mathematical sum.',
    'Use the file tools to make the smallest change possible: modify only src/math.js.',
    'Run npm test after the change and only finish when it passes.',
    'Do not modify package.json, test files, or add generated files.',
    'In your final response, summarize the changed file and test result.',
  ].join('\n');
}

function createInspectionPrompt(): string {
  return [
    'Inspect this repository as a coding agent.',
    'Read src/math.js and the existing tests to diagnose the bug.',
    'Do not edit any files and do not run commands that modify files.',
    'Explain the exact fix needed, then stop and wait for the next instruction.',
  ].join('\n');
}

function createContinuationPrompt(): string {
  return [
    'Continue the same repository task from the previous turn.',
    'The user has approved implementation for this turn and the permission mode is yolo.',
    'Do not call ExitPlanMode or produce another plan; edit the file and run the test now.',
    'Apply the minimal fix you diagnosed so add(left, right) returns the mathematical sum.',
    'Modify only src/math.js, run npm test, and finish only when it passes.',
  ].join('\n');
}

const enabled = isRealApiTestEnabled() && apiKey.length > 0;

describe.skipIf(!enabled)('Blade coding task (real API)', () => {
  describe.each(models)('%s', (model) => {
    it('fixes a bug through the real CLI agent loop and verifies the repository', async () => {
      if (!existsSync(cliEntry)) {
        throw new Error(
          `Missing ${cliEntry}; run "bun run build:cli" before real API tests`
        );
      }

      const workspace = createCodingTaskWorkspace();
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-home-'));

      try {
        const result = await runBladeInvocation(workspace, home, model, {
          prompt: createCodingTaskPrompt(),
        });
        const parsed = parseHeadlessJsonl(result.stdout);
        const toolStarts = parsed.events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);
        const errors = parsed.events.filter((event) => event.type === 'error');
        const diffNames = execFileSync('git', ['diff', '--name-only'], {
          cwd: workspace,
          encoding: 'utf8',
        })
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);

        expect(result.error).toBeUndefined();
        expect(result.status, redactSecrets(result.stderr, [apiKey])).toBe(0);
        expect(parsed.nonJsonLines).toEqual([]);
        expect(errors).toEqual([]);
        expect(toolStarts).toContain('Edit');
        expect(toolStarts).toContain('Bash');
        expect(toolStarts.some((name) => ['Read', 'Glob', 'Grep'].includes(name))).toBe(
          true
        );
        expect(diffNames).toEqual(['src/math.js']);
        expect(readFileSync(path.join(workspace, 'src', 'math.js'), 'utf8')).toContain(
          'return left + right;'
        );

        const testResult = spawnSync('npm', ['test', '--', '--test-reporter=dot'], {
          cwd: workspace,
          encoding: 'utf8',
        });
        expect(testResult.status, testResult.stderr || testResult.stdout).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(apiKey);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 300_000);

    it('resumes a read-only diagnosis in a second CLI process', async () => {
      if (!existsSync(cliEntry)) {
        throw new Error(
          `Missing ${cliEntry}; run "bun run build:cli" before real API tests`
        );
      }

      const workspace = createCodingTaskWorkspace();
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-resume-home-'));
      const sessionId = `real-api-resume-${model}`;

      try {
        const inspection = await runBladeInvocation(workspace, home, model, {
          prompt: createInspectionPrompt(),
          maxTurns: 4,
          sessionId,
          permissionMode: 'plan',
        });
        expect(inspection.error).toBeUndefined();
        expect(inspection.status, redactSecrets(inspection.stderr, [apiKey])).toBe(0);
        expect(
          execFileSync('git', ['diff', '--name-only'], {
            cwd: workspace,
            encoding: 'utf8',
          }).trim()
        ).toBe('');

        const continuation = await runBladeInvocation(workspace, home, model, {
          prompt: createContinuationPrompt(),
          sessionId,
        });
        const parsed = parseHeadlessJsonl(continuation.stdout);
        const toolStarts = parsed.events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);
        expect(continuation.error).toBeUndefined();
        expect(continuation.status, redactSecrets(continuation.stderr, [apiKey])).toBe(
          0
        );
        expect(parsed.nonJsonLines).toEqual([]);
        expect(parsed.events.filter((event) => event.type === 'error')).toEqual([]);
        expect(toolStarts).toContain('Edit');
        expect(toolStarts).toContain('Bash');
        expect(readFileSync(path.join(workspace, 'src', 'math.js'), 'utf8')).toContain(
          'return left + right;'
        );

        const testResult = spawnSync('npm', ['test', '--', '--test-reporter=dot'], {
          cwd: workspace,
          encoding: 'utf8',
        });
        expect(testResult.status, testResult.stderr || testResult.stdout).toBe(0);
        expect(
          `${inspection.stdout}\n${inspection.stderr}\n${continuation.stdout}`
        ).not.toContain(apiKey);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 420_000);
  });
});
