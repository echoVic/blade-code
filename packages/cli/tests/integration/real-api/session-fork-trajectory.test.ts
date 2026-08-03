import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
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
const enabled = isRealApiTestEnabled() && Boolean(apiKey);

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Blade Fork Test',
      GIT_AUTHOR_EMAIL: 'blade-fork-test@example.invalid',
      GIT_COMMITTER_NAME: 'Blade Fork Test',
      GIT_COMMITTER_EMAIL: 'blade-fork-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function createWorkspace(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-session-fork-api-'));
  writeFileSync(path.join(workspace, 'result.txt'), 'BROKEN\n');
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '.']);
  runGit(workspace, ['commit', '-qm', 'fixture']);
  return workspace;
}

function findSessionFile(storageRoot: string, sessionId: string): string {
  const projectsDirectory = path.join(storageRoot, 'projects');
  for (const projectDirectory of readdirSync(projectsDirectory)) {
    const candidate = path.join(
      projectsDirectory,
      projectDirectory,
      `${sessionId}.jsonl`
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing persisted session ${sessionId}`);
}

function runBlade(
  workspace: string,
  home: string,
  model: string,
  args: string[]
): Promise<CommandResult> {
  const storageRoot = path.join(home, '.blade');
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(
    path.join(storageRoot, 'config.json'),
    JSON.stringify(
      buildRealApiConfig({ modelId: model, model, baseUrl, maxOutputTokens: 2_048 }),
      null,
      2
    )
  );

  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [
        cliEntry,
        '--headless',
        '--output-format',
        'jsonl',
        '--permission-mode',
        'yolo',
        '--max-turns',
        '16',
        '--model',
        model,
        ...args,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          BLADE_STORAGE_ROOT: storageRoot,
          BLADE_API_KEY: apiKey,
          BLADE_TELEMETRY_DISABLED: '1',
          BLADE_ALLOW_ROOT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
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

describe.skipIf(!enabled)('CLI session fork trajectory (real API)', () => {
  describe.each(models)('%s', (model) => {
    it('inherits history in a child process without mutating the parent transcript', async () => {
      if (!existsSync(cliEntry)) {
        throw new Error(
          `Missing ${cliEntry}; run "bun run build:cli" before real API tests`
        );
      }

      const workspace = createWorkspace();
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-session-fork-home-'));
      const storageRoot = path.join(home, '.blade');
      const suffix = model.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase();
      const memorizedValue = `FORK_HISTORY_${suffix}`;
      const parentSessionId = `fork-parent-${model}`;
      const childSessionId = `fork-child-${model}`;

      try {
        const initial = await runBlade(workspace, home, model, [
          '--session-id',
          parentSessionId,
          [
            `Memorize the exact token ${memorizedValue}.`,
            'It will not appear in the next prompt. Do not call tools.',
            'Reply with exactly READY.',
          ].join(' '),
        ]);
        expect(initial.error).toBeUndefined();
        expect(initial.status, redactSecrets(initial.stderr, [apiKey])).toBe(0);
        expect(parseHeadlessJsonl(initial.stdout).nonJsonLines).toEqual([]);

        const parentPath = findSessionFile(storageRoot, parentSessionId);
        const parentBeforeFork = readFileSync(parentPath, 'utf8');
        const parentEvents = parentBeforeFork
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as SessionEvent);

        const forked = await runBlade(workspace, home, model, [
          '--resume',
          parentSessionId,
          '--fork-session',
          '--session-id',
          childSessionId,
          [
            'Use the exact token I asked you to memorize earlier.',
            'Read result.txt, replace the entire file with only that token and a newline,',
            'Do not inspect or modify other files.',
          ].join(' '),
        ]);
        const parsed = parseHeadlessJsonl(forked.stdout);
        const toolStarts = parsed.events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);

        expect(forked.error).toBeUndefined();
        expect(forked.status, redactSecrets(forked.stderr, [apiKey])).toBe(0);
        expect(parsed.nonJsonLines).toEqual([]);
        expect(parsed.events.filter((event) => event.type === 'error')).toEqual([]);
        expect(toolStarts).toContain('Read');
        expect(readFileSync(path.join(workspace, 'result.txt'), 'utf8').trim()).toBe(
          memorizedValue
        );
        expect(
          spawnSync('git', ['diff', '--name-only'], {
            cwd: workspace,
            encoding: 'utf8',
          }).stdout.trim()
        ).toBe('result.txt');
        expect(readFileSync(parentPath, 'utf8')).toBe(parentBeforeFork);

        const childPath = findSessionFile(storageRoot, childSessionId);
        const childContent = readFileSync(childPath, 'utf8');
        const childEvents = childContent
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as SessionEvent);
        expect(childEvents[0]).toMatchObject({
          type: 'session_created',
          sessionId: childSessionId,
          data: {
            parentId: parentSessionId,
            relationType: 'fork',
          },
        });
        expect(childEvents.every((event) => event.sessionId === childSessionId)).toBe(
          true
        );
        expect(
          childEvents.every(
            (event) => !parentEvents.some((parent) => parent.id === event.id)
          )
        ).toBe(true);
        expect(childContent).toContain(memorizedValue);
        expect(
          `${initial.stdout}\n${initial.stderr}\n${forked.stdout}\n${forked.stderr}`
        ).not.toContain(apiKey);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 360_000);
  });
});
