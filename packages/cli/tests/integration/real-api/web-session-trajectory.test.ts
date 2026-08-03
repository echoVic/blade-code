import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { BladeServer } from '../../../src/server/server.js';
import { getState } from '../../../src/store/vanilla.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  type TestModelConfig,
} from './testConfig.js';

interface SurfaceEvent {
  type: string;
  properties: Record<string, unknown>;
}

interface EventCollector {
  events: SurfaceEvent[];
  waitFor: (
    predicate: (event: SurfaceEvent) => boolean,
    timeoutMs?: number
  ) => Promise<void>;
  close: () => Promise<void>;
}

const modelConfigs = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const enabled = modelConfigs.length > 0;
let server: Awaited<ReturnType<typeof BladeServer.listenAsync>> | undefined;
let originalConfig: RuntimeConfig | null = null;

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Blade Web Test',
      GIT_AUTHOR_EMAIL: 'blade-web-test@example.invalid',
      GIT_COMMITTER_NAME: 'Blade Web Test',
      GIT_COMMITTER_EMAIL: 'blade-web-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function createWorkspace(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-web-real-api-'));
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(path.join(workspace, 'test'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'blade-web-real-api',
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
      '});',
      '',
    ].join('\n')
  );
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '.']);
  runGit(workspace, ['commit', '-qm', 'fixture']);
  return workspace;
}

function setRuntimeModel(
  modelConfig: TestModelConfig,
  maxContextTokens = 64_000
): void {
  const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
  runtimeConfig.models[0]!.maxContextTokens = maxContextTokens;
  getState().config.actions.setConfig(runtimeConfig);
}

async function createSession(workspace: string): Promise<string> {
  if (!server) throw new Error('Blade web server is not running');
  const response = await fetch(new URL('/sessions', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: workspace, title: 'Real API surface test' }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { sessionId: string };
  return session.sessionId;
}

async function collectEvents(sessionId: string): Promise<EventCollector> {
  if (!server) throw new Error('Blade web server is not running');
  const controller = new AbortController();
  const response = await fetch(new URL(`/sessions/${sessionId}/events`, server.url), {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error('SSE response did not include a body');

  const events: SurfaceEvent[] = [];
  const waiters = new Set<{
    predicate: (event: SurfaceEvent) => boolean;
    resolve: () => void;
  }>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (rawEvent: string) => {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as SurfaceEvent;
    events.push(event);
    for (const waiter of waiters) {
      if (waiter.predicate(event)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) consume(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();

  const waitFor = async (
    predicate: (event: SurfaceEvent) => boolean,
    timeoutMs = 180_000
  ): Promise<void> => {
    if (events.some(predicate)) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const waiter: {
      predicate: (event: SurfaceEvent) => boolean;
      resolve: () => void;
    } = { predicate, resolve: () => undefined };
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          waiter.resolve = resolve;
          waiters.add(waiter);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error(`Timed out waiting for SSE event after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      waiters.delete(waiter);
      if (timeout) clearTimeout(timeout);
    }
  };

  await waitFor((event) => event.type === 'connected', 10_000);
  return {
    events,
    waitFor,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading.catch(() => undefined);
    },
  };
}

async function sendMessage(
  sessionId: string,
  content: string
): Promise<{ runId: string; status: string; queued?: number }> {
  if (!server) throw new Error('Blade web server is not running');
  const response = await fetch(new URL(`/sessions/${sessionId}/message`, server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, permissionMode: 'yolo' }),
  });
  expect(response.status).toBe(202);
  return response.json() as Promise<{
    runId: string;
    status: string;
    queued?: number;
  }>;
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!server) return;
  const response = await fetch(new URL(`/sessions/${sessionId}`, server.url), {
    method: 'DELETE',
  });
  expect(response.status).toBe(200);
}

function codingPrompt(): string {
  return [
    'Work on this repository as a coding agent.',
    'Read src/math.js and the existing test before editing.',
    'Fix add(left, right) so it returns the mathematical sum.',
    'Modify only src/math.js, run npm test, and finish only when it passes.',
  ].join('\n');
}

function compactionPrompt(): string {
  const archivedContext = Array.from(
    { length: 1_000 },
    (_, index) =>
      `Archived diagnostic record ${index}: historical-only context; preserve the active file task.`
  ).join('\n');
  return [
    'Perform a context-compaction continuation audit in this repository.',
    'First call Read for package.json and wait for its result.',
    'Then use Write to create compacted.txt containing exactly the single line compacted.',
    'Do not read or modify any other file. Finish immediately after Write succeeds.',
    '<archived-context>',
    archivedContext,
    '</archived-context>',
  ].join('\n');
}

beforeAll(async () => {
  if (!enabled) return;
  originalConfig = getState().config.config;
  server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });
});

afterAll(async () => {
  await server?.stop();
  server = undefined;
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
});

describe.skipIf(!enabled)('Web session trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} fixes and verifies code through HTTP and SSE`, async () => {
      const workspace = createWorkspace();
      let sessionId: string | undefined;
      let collector: EventCollector | undefined;
      try {
        setRuntimeModel(modelConfig);
        sessionId = await createSession(workspace);
        collector = await collectEvents(sessionId);
        await sendMessage(sessionId, codingPrompt());
        await collector.waitFor((event) => event.type === 'session.completed');
        await collector.waitFor(
          (event) =>
            event.type === 'session.status' && event.properties.status === 'idle'
        );

        const types = collector.events.map((event) => event.type);
        expect(types).toContain('turn.started');
        expect(types).toContain('tool.start');
        expect(types).toContain('tool.result');
        expect(types).not.toContain('session.error');
        expect(
          collector.events
            .filter((event) => event.type === 'tool.result')
            .every((event) => typeof event.properties.success === 'boolean')
        ).toBe(true);
        expect(readFileSync(path.join(workspace, 'src', 'math.js'), 'utf8')).toContain(
          'return left + right;'
        );
        expect(
          execFileSync('git', ['diff', '--name-only'], {
            cwd: workspace,
            encoding: 'utf8',
          }).trim()
        ).toBe('src/math.js');
        const test = spawnSync('npm', ['test', '--', '--test-reporter=dot'], {
          cwd: workspace,
          encoding: 'utf8',
        });
        expect(test.status, test.stderr || test.stdout).toBe(0);
        expect(JSON.stringify(collector.events)).not.toContain(modelConfig.apiKey);
      } finally {
        await collector?.close();
        if (sessionId) await deleteSession(sessionId);
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 300_000);

    it(`${modelConfig.model} exposes paired compaction events before resumed write`, async () => {
      const workspace = createWorkspace();
      let sessionId: string | undefined;
      let collector: EventCollector | undefined;
      try {
        setRuntimeModel(modelConfig, 28_000);
        sessionId = await createSession(workspace);
        collector = await collectEvents(sessionId);
        await sendMessage(sessionId, compactionPrompt());
        await collector.waitFor((event) => event.type === 'session.completed', 300_000);
        await collector.waitFor(
          (event) =>
            event.type === 'session.status' && event.properties.status === 'idle'
        );

        const compactStart = collector.events.findIndex(
          (event) => event.type === 'compaction.started'
        );
        const compactEnd = collector.events.findIndex(
          (event) => event.type === 'compaction.completed'
        );
        const writeStart = collector.events.findIndex(
          (event) =>
            event.type === 'tool.start' &&
            ['Write', 'Edit'].includes(String(event.properties.toolName))
        );
        expect(compactStart).toBeGreaterThanOrEqual(0);
        expect(compactEnd).toBeGreaterThan(compactStart);
        expect(writeStart).toBeGreaterThan(compactEnd);
        expect(readFileSync(path.join(workspace, 'compacted.txt'), 'utf8')).toMatch(
          /^compacted\r?\n?$/
        );
        expect(JSON.stringify(collector.events)).not.toContain(modelConfig.apiKey);
      } finally {
        await collector?.close();
        if (sessionId) await deleteSession(sessionId);
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} steers an active Web turn without starting a concurrent run`, async () => {
      const workspace = createWorkspace();
      let sessionId: string | undefined;
      let collector: EventCollector | undefined;
      try {
        setRuntimeModel(modelConfig);
        sessionId = await createSession(workspace);
        collector = await collectEvents(sessionId);

        const initial = await sendMessage(
          sessionId,
          'A configuration review is in progress. The current candidate value is ' +
            'ALPHA_VALUE. Reply with the current candidate value only. Do not call tools.'
        );
        await collector.waitFor((event) => event.type === 'turn.started');
        const steered = await sendMessage(
          sessionId,
          'New information from the user: the candidate value is now BETA_VALUE. ' +
            'Reply with the newest candidate value only.'
        );

        expect(steered).toMatchObject({
          runId: initial.runId,
          status: 'steering_queued',
        });
        await collector.waitFor((event) => event.type === 'steering.queued');
        await collector.waitFor((event) => event.type === 'steering.applied');
        await collector.waitFor((event) => event.type === 'session.completed');

        const appliedIndex = collector.events.findIndex(
          (event) => event.type === 'steering.applied'
        );
        const responseAfterSteering = collector.events
          .slice(appliedIndex + 1)
          .filter((event) => event.type === 'message.delta')
          .map((event) => String(event.properties.delta ?? ''))
          .join('');
        expect(responseAfterSteering).toContain('BETA_VALUE');
        expect(
          collector.events.filter((event) => event.type === 'turn.started').length
        ).toBeGreaterThanOrEqual(2);
        expect(collector.events.map((event) => event.type)).not.toContain(
          'session.error'
        );
      } finally {
        await collector?.close();
        if (sessionId) await deleteSession(sessionId);
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
