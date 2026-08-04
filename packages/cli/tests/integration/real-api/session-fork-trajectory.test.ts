import { spawn, spawnSync } from 'node:child_process';
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
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import { buildRealApiConfig, parseHeadlessJsonl } from './codingTaskHarness.js';
import {
  assertForkChildToolTrace,
  assertForkLineage,
  assertForkParentToolTrace,
  assertNoSecrets,
  assertParentUnchanged,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
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

function createWorkspace(expectedBytes: string): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-session-fork-api-'));
  writeFileSync(path.join(workspace, 'memory.txt'), expectedBytes);
  writeFileSync(path.join(workspace, 'result.txt'), 'BROKEN\n');
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '.']);
  runGit(workspace, ['commit', '-qm', 'fixture']);
  return workspace;
}

function parseSuccessfulRun(result: CommandResult, label: string) {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} CLI run failed`);
  }
  const parsed = parseHeadlessJsonl(result.stdout);
  if (parsed.nonJsonLines.length > 0) {
    throw new Error(`${label} CLI emitted malformed JSONL`);
  }
  if (parsed.events.some((event) => event.type === 'error')) {
    throw new Error(`${label} CLI emitted an error event`);
  }
  return parsed;
}

function finalHeadlessText(
  events: ReturnType<typeof parseHeadlessJsonl>['events']
): string {
  const streamEnd = events.findLastIndex((event) => event.type === 'stream_end');
  if (streamEnd < 0) throw new Error('CLI final response has no stream boundary');
  const previousStreamEnd = events
    .slice(0, streamEnd)
    .findLastIndex((event) => event.type === 'stream_end');
  return events
    .slice(previousStreamEnd + 1, streamEnd)
    .flatMap((event) =>
      event.type === 'content_delta'
        ? [event.delta]
        : event.type === 'content'
          ? [event.content]
          : []
    )
    .join('');
}

function assertSafeFinal(
  events: ReturnType<typeof parseHeadlessJsonl>['events'],
  marker: string,
  nonce: string,
  label: string
): void {
  const text = finalHeadlessText(events);
  if (!text.trim()) throw new Error(`${label} CLI final response was empty`);
  if (text.includes(marker) || text.includes(nonce)) {
    throw new Error(`${label} CLI final response exposed fixture material`);
  }
}

function findForkBoundaryEventCount(
  events: readonly SessionEvent[],
  expected: { childId: string; parentId: string; rootId: string }
): number {
  const boundaryIndex = events.findLastIndex(
    (event) =>
      event.type === 'session_updated' &&
      event.data.sessionId === expected.childId &&
      event.data.parentId === expected.parentId &&
      event.data.rootId === expected.rootId &&
      event.data.relationType === 'fork'
  );
  if (boundaryIndex < 0) {
    throw new Error('Fork child transcript has no complete lineage boundary');
  }
  return boundaryIndex + 1;
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

      const suffix = model.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase();
      const memorizedValue = `FORK_HISTORY_${suffix}`;
      const expectedBytes = `${memorizedValue}\n`;
      const workspace = createWorkspace(expectedBytes);
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-session-fork-home-'));
      const storageRoot = path.join(home, '.blade');
      const memoryPath = path.join(workspace, 'memory.txt');
      const resultPath = path.join(workspace, 'result.txt');
      const nonce = path.basename(workspace);
      const parentSessionId = `fork-parent-${model}`;
      const childSessionId = `fork-child-${model}`;

      try {
        const parentPrompt = [
          `Use the Read tool on the exact absolute path ${memoryPath}.`,
          'Remember the complete file contents for a later fork.',
          'Use no other tools.',
          'Do not repeat, quote, encode, or summarize the file contents in final prose.',
          'After the successful Read, give a brief completion confirmation.',
        ].join(' ');
        const initial = await runBlade(workspace, home, model, [
          '--allowed-tools',
          'Read',
          '--session-id',
          parentSessionId,
          parentPrompt,
        ]);
        const initialParsed = parseSuccessfulRun(initial, 'Parent');
        assertSafeFinal(initialParsed.events, memorizedValue, nonce, 'Parent');

        const parentPath = findSessionTranscript(storageRoot, parentSessionId);
        const parentBeforeFork = readFileSync(parentPath, 'utf8');
        const parentEvents = readSessionEvents(parentPath);
        assertForkParentToolTrace(extractDurableToolTrace(parentEvents), memoryPath);

        rmSync(memoryPath);
        if (existsSync(memoryPath)) {
          throw new Error('Source memory fixture still exists before CLI fork');
        }
        const childPrompt = [
          'Recover the complete marker from the inherited successful Read result.',
          `Use Write exactly once on the exact absolute path ${resultPath} with that marker and exactly one trailing newline.`,
          'Then use Bash exactly once with the exact command `wc -c result.txt`.',
          'Use no other tools or commands.',
          'Do not repeat the marker in final prose; briefly confirm completion.',
        ].join(' ');
        if (childPrompt.includes(memorizedValue)) {
          throw new Error('Fork child prompt exposed fixture material');
        }

        const forked = await runBlade(workspace, home, model, [
          '--allowed-tools',
          'Write,Bash',
          '--resume',
          parentSessionId,
          '--fork-session',
          '--session-id',
          childSessionId,
          childPrompt,
        ]);
        const parsed = parseSuccessfulRun(forked, 'Child');
        assertSafeFinal(parsed.events, memorizedValue, nonce, 'Child');
        if (readFileSync(resultPath, 'utf8') !== expectedBytes) {
          throw new Error('Fork child result bytes did not match the exact contract');
        }
        expect(
          spawnSync('git', ['diff', '--name-only'], {
            cwd: workspace,
            encoding: 'utf8',
          }).stdout.trim()
        ).toBe(['memory.txt', 'result.txt'].join('\n'));
        assertParentUnchanged(parentBeforeFork, parentPath);

        const childPath = findSessionTranscript(storageRoot, childSessionId);
        const childContent = readFileSync(childPath, 'utf8');
        const childEvents = readSessionEvents(childPath);
        const expectedLineage = {
          childId: childSessionId,
          parentId: parentSessionId,
          rootId: parentSessionId,
        };
        assertForkLineage(childEvents, expectedLineage);
        const forkBoundaryEventCount = findForkBoundaryEventCount(
          childEvents,
          expectedLineage
        );
        assertForkParentToolTrace(
          extractDurableToolTrace(childEvents.slice(0, forkBoundaryEventCount)),
          memoryPath
        );
        assertForkChildToolTrace(
          extractDurableToolTrace(childEvents, {
            afterEventCount: forkBoundaryEventCount,
          }),
          resultPath,
          expectedBytes
        );
        if (!childContent.includes(memorizedValue)) {
          throw new Error('Fork child transcript did not inherit fixture material');
        }
        expect(childEvents.length).toBeGreaterThan(forkBoundaryEventCount);
        expect(
          childEvents.every(
            (event) => !parentEvents.some((parent) => parent.id === event.id)
          )
        ).toBe(true);
        assertNoSecrets(
          {
            initial,
            forked,
            parentBeforeFork,
            childContent,
          },
          [apiKey, baseUrl]
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 360_000);
  });
});
