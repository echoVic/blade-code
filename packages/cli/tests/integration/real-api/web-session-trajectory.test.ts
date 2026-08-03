import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
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
    reject: (error: Error) => void;
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
    if (event.type === 'session.error') {
      const error = new Error(
        `Web session failed: ${JSON.stringify(event.properties)}`
      );
      for (const waiter of waiters) {
        waiters.delete(waiter);
        waiter.reject(error);
      }
      return;
    }
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
    const sessionError = events.find((event) => event.type === 'session.error');
    if (sessionError) {
      throw new Error(`Web session failed: ${JSON.stringify(sessionError.properties)}`);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const waiter: {
      predicate: (event: SurfaceEvent) => boolean;
      resolve: () => void;
      reject: (error: Error) => void;
    } = {
      predicate,
      resolve: () => undefined,
      reject: () => undefined,
    };
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          waiter.resolve = resolve;
          waiter.reject = reject;
          waiters.add(waiter);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const recentEvents = events
              .slice(-20)
              .map((event) => event.type)
              .join(', ');
            reject(
              new Error(
                `Timed out waiting for SSE event after ${timeoutMs}ms. ` +
                  `Recent events: ${recentEvents || '(none)'}`
              )
            );
          }, timeoutMs);
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
): Promise<{ runId: string; messageId?: string; status: string; queued?: number }> {
  if (!server) throw new Error('Blade web server is not running');
  const response = await fetch(new URL(`/sessions/${sessionId}/message`, server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, permissionMode: 'yolo' }),
  });
  if (response.status !== 202) {
    throw new Error(
      `Web message returned ${response.status}: ${await response.text()}`
    );
  }
  return response.json() as Promise<{
    runId: string;
    messageId?: string;
    status: string;
    queued?: number;
  }>;
}

async function forkSession(sessionId: string): Promise<{
  sessionId: string;
  parentId: string;
  relationType: string;
}> {
  if (!server) throw new Error('Blade web server is not running');
  const response = await fetch(new URL(`/sessions/${sessionId}/fork`, server.url), {
    method: 'POST',
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    sessionId: string;
    parentId: string;
    relationType: string;
  }>;
}

async function getSessionMessages(sessionId: string): Promise<unknown[]> {
  if (!server) throw new Error('Blade web server is not running');
  const response = await fetch(new URL(`/sessions/${sessionId}/message`, server.url));
  expect(response.status).toBe(200);
  return response.json() as Promise<unknown[]>;
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
    it(`${modelConfig.model} branches durable context through Web without mutating its parent`, async () => {
      const workspace = createWorkspace();
      const marker = `WEB_BRANCH_${modelConfig.model.replaceAll(/[^A-Za-z0-9]/g, '_')}`;
      const markerPath = path.join(workspace, 'branch-marker.txt');
      const resultPath = path.join(workspace, 'branch-result.txt');
      writeFileSync(markerPath, `${marker}\n`);
      let parentId: string | undefined;
      let childId: string | undefined;
      let parentCollector: EventCollector | undefined;
      let childCollector: EventCollector | undefined;

      try {
        setRuntimeModel(modelConfig);
        parentId = await createSession(workspace);
        parentCollector = await collectEvents(parentId);
        await sendMessage(
          parentId,
          'Read branch-marker.txt. Do not modify files and do not repeat the file contents. ' +
            'After the Read tool succeeds, reply only with "Marker captured.".'
        );
        await parentCollector.waitFor(
          (event) => event.type === 'session.completed',
          300_000
        );
        await parentCollector.waitFor(
          (event) =>
            event.type === 'session.status' && event.properties.status === 'idle'
        );
        const parentMessagesBefore = await getSessionMessages(parentId);

        const child = await forkSession(parentId);
        childId = child.sessionId;
        expect(child).toMatchObject({
          parentId,
          relationType: 'fork',
        });
        unlinkSync(markerPath);
        childCollector = await collectEvents(childId);
        await sendMessage(
          childId,
          'Use the exact marker from the earlier Read tool result. Write it as the only ' +
            'line in branch-result.txt, then run Bash with "wc -c branch-result.txt" before finishing.'
        );
        await childCollector.waitFor(
          (event) => event.type === 'session.completed',
          300_000
        );
        await childCollector.waitFor(
          (event) =>
            event.type === 'session.status' && event.properties.status === 'idle'
        );

        expect(readFileSync(resultPath, 'utf8').trim()).toBe(marker);
        expect(
          childCollector.events.some(
            (event) =>
              event.type === 'tool.start' && event.properties.toolName === 'Bash'
          )
        ).toBe(true);
        expect(await getSessionMessages(parentId)).toEqual(parentMessagesBefore);
        expect(await getSessionMessages(childId)).not.toEqual(parentMessagesBefore);
        expect(JSON.stringify(childCollector.events)).not.toContain(modelConfig.apiKey);
      } finally {
        await parentCollector?.close();
        await childCollector?.close();
        if (childId) await deleteSession(childId);
        if (parentId) await deleteSession(parentId);
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 360_000);

    it(`${modelConfig.model} fixes and verifies code through HTTP and SSE`, async () => {
      const workspace = createWorkspace();
      let sessionId: string | undefined;
      let collector: EventCollector | undefined;
      try {
        setRuntimeModel(modelConfig);
        sessionId = await createSession(workspace);
        collector = await collectEvents(sessionId);
        const accepted = await sendMessage(sessionId, codingPrompt());
        expect(accepted).toMatchObject({
          status: 'running',
          messageId: expect.any(String),
        });
        const durableInbox = JSON.parse(
          readFileSync(getSessionInboxFilePath(workspace, sessionId), 'utf8')
        ) as { messages: Array<{ id: string }> };
        expect(durableInbox.messages[0]?.id).toBe(accepted.messageId);
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
        expect(existsSync(getSessionInboxFilePath(workspace, sessionId))).toBe(false);
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
          'We are choosing a TypeScript identifier before editing code. The current ' +
            'requested identifier is ALPHA_CANDIDATE_IDENTIFIER. Reply with that ' +
            'identifier only. Do not call tools.'
        );
        await collector.waitFor((event) => event.type === 'turn.started');
        const steered = await sendMessage(
          sessionId,
          'Requirement update: use BETA_CANDIDATE_IDENTIFIER instead. Reply with ' +
            'the newest requested identifier only.'
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
        expect(responseAfterSteering).toContain('BETA_CANDIDATE_IDENTIFIER');
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

    it(`${modelConfig.model} auto-resumes durable input when Web SSE reconnects`, async () => {
      const workspace = createWorkspace();
      let sessionId: string | undefined;
      let collector: EventCollector | undefined;
      let runtime: SessionRuntime | undefined;
      try {
        setRuntimeModel(modelConfig);
        sessionId = `web-recovery-${Date.now()}`;
        runtime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
        });
        const durablePrompt =
          'The old value was ALPHA_WEB_RECOVERY. The newest value is ' +
          'BETA_WEB_RECOVERY. Reply with the newest value only.';
        const prepared = await runtime.prepareInputTurn(durablePrompt);
        expect(prepared).toMatchObject({
          accepted: true,
          mode: 'direct',
          queued: 1,
        });
        if (!prepared.accepted) {
          throw new Error('Expected durable input preparation to succeed');
        }
        const inboxMessageId = prepared.messageId;
        await runtime.dispose();
        runtime = undefined;

        collector = await collectEvents(sessionId);
        await collector.waitFor((event) => event.type === 'follow_up.started');
        await collector.waitFor((event) => event.type === 'session.completed');

        const recoveredUser = collector.events.find(
          (event) =>
            event.type === 'message.created' &&
            event.properties.role === 'user' &&
            event.properties.recovered === true
        );
        expect(recoveredUser).toMatchObject({
          properties: expect.objectContaining({
            messageId: inboxMessageId,
            content: durablePrompt,
          }),
        });
        const output = collector.events
          .filter((event) => event.type === 'message.delta')
          .map((event) => String(event.properties.delta ?? ''))
          .join('');
        expect(output).toContain('BETA_WEB_RECOVERY');
        expect(collector.events.map((event) => event.type)).not.toContain(
          'session.error'
        );
        expect(existsSync(getSessionInboxFilePath(workspace, sessionId))).toBe(false);
      } finally {
        await runtime?.dispose().catch(() => undefined);
        await collector?.close();
        if (sessionId) await deleteSession(sessionId);
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
