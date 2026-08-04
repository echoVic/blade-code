import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import {
  BusEventSchema,
  ForkSessionResponseSchema,
  type SessionRef,
  SessionRefSchema,
  SessionSchema,
} from '../../../src/api/schemas.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { BladeServer } from '../../../src/server/server.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import {
  assertForkChildToolTrace,
  assertForkLineage,
  assertForkParentToolTrace,
  assertForkSnapshotExcludesParentSuffix,
  assertNoSecrets,
  assertParentUnchanged,
  cleanupForkFixture,
  createForkFixture,
  extractDurableToolTrace,
  type ForkFixture,
  findSessionTranscript,
  readSessionEvents,
  startHeldProviderProxy,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
if (enabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error(
    'Web fork qualification requires DeepSeek credentials from the process environment'
  );
}
const modelConfigs = enabled
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true })
  : [];

const SessionListSchema = z.array(SessionSchema);
const AcceptedMessageSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  status: z.literal('running'),
});
const SessionStatusSchema = z.object({
  sessionId: z.string(),
  projectPath: z.string(),
  runId: z.string().optional(),
  status: z.enum([
    'idle',
    'running',
    'waiting_permission',
    'completed',
    'failed',
    'cancelled',
  ]),
});
const DeleteSessionSchema = z.object({ success: z.literal(true) });

type SurfaceEvent = z.infer<typeof BusEventSchema>;

interface EventCollector {
  events: SurfaceEvent[];
  waitFor(
    predicate: (event: SurfaceEvent) => boolean,
    options?: { afterIndex?: number; label?: string; timeoutMs?: number }
  ): Promise<SurfaceEvent>;
  close(): Promise<void>;
}

interface TestServer {
  url: string | URL;
  stop(): Promise<void>;
}

function safeModelLabel(modelConfig: TestModelConfig, ordinal: number): string {
  const digest = createHash('sha256')
    .update(modelConfig.qualificationId)
    .digest('hex')
    .slice(0, 12);
  return `${modelConfig.id}-${ordinal + 1}-${digest}`;
}

function createResolvedConfig(
  modelConfig: TestModelConfig,
  allowedTools: string[],
  overrides: { baseURL?: string; idSuffix?: string } = {}
): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  const selected = base.models[0];
  if (!selected) throw new Error('Web fork qualification model config is empty');
  const modelId = overrides.idSuffix
    ? `${selected.id}-${overrides.idSuffix}`
    : selected.id;
  return {
    ...base,
    currentModelId: modelId,
    models: [
      {
        ...selected,
        id: modelId,
        ...(overrides.baseURL ? { baseUrl: overrides.baseURL } : {}),
      },
    ],
    permissionMode: PermissionMode.YOLO,
    allowedTools,
    disallowedTools: [],
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpEnabled: false,
    mcpServers: {},
  };
}

function initializeIsolatedExtensions(fixture: ForkFixture): void {
  const userSkillsDir = path.join(fixture.storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(fixture.storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(fixture.workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(fixture.workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  for (const directory of [
    skillCreatorDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    path.join(skillCreatorDir, 'SKILL.md'),
    [
      '---',
      'name: skill-creator',
      'description: Local qualification fixture that prevents network installation.',
      '---',
      '',
      '# Fixture Skill Creator',
      '',
      'This fixture is local and deterministic.',
      '',
    ].join('\n')
  );

  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: fixture.workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

function endpoint(server: TestServer, pathname: string): URL {
  return new URL(pathname.replace(/^\//, ''), server.url);
}

function withProjectPath(url: URL, projectPath: string): URL {
  url.searchParams.set('projectPath', projectPath);
  return url;
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function createSession(
  server: TestServer,
  projectPath: string
): Promise<SessionRef> {
  const response = await fetch(endpoint(server, '/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath, title: 'Web fork qualification' }),
  });
  const session = SessionSchema.parse(await responseJson(response, 'create session'));
  return SessionRefSchema.parse({ sessionId: session.sessionId, projectPath });
}

async function listSession(server: TestServer, ref: SessionRef): Promise<void> {
  const sessions = SessionListSchema.parse(
    await responseJson(
      await fetch(withProjectPath(endpoint(server, '/sessions'), ref.projectPath)),
      'list sessions'
    )
  );
  expect(
    sessions.some(
      (session) =>
        session.sessionId === ref.sessionId && session.projectPath === ref.projectPath
    )
  ).toBe(true);
}

async function forkSession(
  server: TestServer,
  parent: SessionRef
): Promise<{ ref: SessionRef; response: z.infer<typeof ForkSessionResponseSchema> }> {
  const response = await fetch(endpoint(server, `/sessions/${parent.sessionId}/fork`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: parent.projectPath }),
  });
  if (response.status !== 201) {
    throw new Error(`fork session failed with HTTP ${response.status}`);
  }
  const parsed = ForkSessionResponseSchema.parse(await response.json());
  return {
    ref: SessionRefSchema.parse({
      sessionId: parsed.session.sessionId,
      projectPath: parsed.session.projectPath,
    }),
    response: parsed,
  };
}

async function sendMessage(
  server: TestServer,
  ref: SessionRef,
  content: string
): Promise<z.infer<typeof AcceptedMessageSchema>> {
  const response = await fetch(
    withProjectPath(
      endpoint(server, `/sessions/${ref.sessionId}/message`),
      ref.projectPath
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        permissionMode: 'yolo',
        projectPath: ref.projectPath,
      }),
    }
  );
  if (response.status !== 202) {
    throw new Error(`send message failed with HTTP ${response.status}`);
  }
  return AcceptedMessageSchema.parse(await response.json());
}

async function getStatus(
  server: TestServer,
  ref: SessionRef
): Promise<z.infer<typeof SessionStatusSchema>> {
  return SessionStatusSchema.parse(
    await responseJson(
      await fetch(
        withProjectPath(
          endpoint(server, `/sessions/${ref.sessionId}/status`),
          ref.projectPath
        )
      ),
      'get session status'
    )
  );
}

async function deleteSession(server: TestServer, ref: SessionRef): Promise<void> {
  const response = await fetch(
    withProjectPath(endpoint(server, `/sessions/${ref.sessionId}`), ref.projectPath),
    { method: 'DELETE' }
  );
  DeleteSessionSchema.parse(await responseJson(response, 'delete session'));
}

async function collectEvents(
  server: TestServer,
  ref: SessionRef
): Promise<EventCollector> {
  const controller = new AbortController();
  const response = await fetch(
    withProjectPath(
      endpoint(server, `/sessions/${ref.sessionId}/events`),
      ref.projectPath
    ),
    { signal: controller.signal }
  );
  if (!response.ok) {
    throw new Error(`connect SSE failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('SSE response body is missing');

  const events: SurfaceEvent[] = [];
  const waiters = new Set<{
    predicate: (event: SurfaceEvent) => boolean;
    resolve: (event: SurfaceEvent) => void;
    reject: (error: Error) => void;
  }>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (rawFrame: string): void => {
    const data = rawFrame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = BusEventSchema.parse(JSON.parse(data));
    events.push(event);
    if (event.type === 'session.error') {
      const error = new Error('Web session emitted session.error');
      for (const waiter of waiters) {
        waiters.delete(waiter);
        waiter.reject(error);
      }
      return;
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  };

  const reading = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
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
    options: { afterIndex?: number; label?: string; timeoutMs?: number } = {}
  ): Promise<SurfaceEvent> => {
    const afterIndex = options.afterIndex ?? 0;
    const label = options.label ?? 'event';
    const timeoutMs = options.timeoutMs ?? 180_000;
    const scopedPredicate = (event: SurfaceEvent): boolean => {
      const index = events.indexOf(event);
      return index >= afterIndex && predicate(event);
    };
    const existing = events.slice(afterIndex).find(predicate);
    if (existing) return existing;
    if (events.slice(afterIndex).some((event) => event.type === 'session.error')) {
      throw new Error('Web session emitted session.error');
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const waiter = {
      predicate: scopedPredicate,
      resolve: (_event: SurfaceEvent): void => undefined,
      reject: (_error: Error): void => undefined,
    };
    try {
      return await Promise.race([
        new Promise<SurfaceEvent>((resolve, reject) => {
          waiter.resolve = resolve;
          waiter.reject = reject;
          waiters.add(waiter);
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const recentTypes = events
              .slice(Math.max(afterIndex, events.length - 20))
              .map((event) =>
                event.type === 'session.status'
                  ? `${event.type}:${String(event.properties.status ?? 'unknown')}`
                  : event.type
              )
              .join(',');
            reject(
              new Error(
                `SSE wait for ${label} timed out after ${timeoutMs}ms; recent events: ${recentTypes || 'none'}`
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

  await waitFor(
    (event) =>
      event.type === 'connected' &&
      event.properties.sessionId === ref.sessionId &&
      event.properties.projectPath === ref.projectPath,
    { label: 'connected', timeoutMs: 10_000 }
  );
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

async function waitForRunCompletion(
  server: TestServer,
  ref: SessionRef,
  collector: EventCollector,
  runId: string,
  afterIndex: number
): Promise<void> {
  await collector.waitFor(
    (event) => event.type === 'session.completed' && event.properties.runId === runId,
    { afterIndex, label: 'session.completed' }
  );
  await collector.waitFor(
    (event) => event.type === 'session.status' && event.properties.status === 'idle',
    { afterIndex, label: 'session.status:idle' }
  );
  expect(await getStatus(server, ref)).toEqual({
    sessionId: ref.sessionId,
    projectPath: ref.projectPath,
    runId,
    status: 'completed',
  });
}

function assertCollectorIdentity(collector: EventCollector, ref: SessionRef): void {
  for (const event of collector.events) {
    if (event.type === 'heartbeat') continue;
    if (
      event.properties.sessionId !== ref.sessionId ||
      event.properties.projectPath !== ref.projectPath
    ) {
      throw new Error('SSE event violated the compound session identity');
    }
  }
}

function assertSurfaceEventTypes(
  collector: EventCollector,
  afterIndex: number,
  requiredTypes: readonly string[]
): void {
  const observedTypes = new Set(
    collector.events.slice(afterIndex).map((event) => event.type)
  );
  for (const type of requiredTypes) {
    if (!observedTypes.has(type)) {
      throw new Error(`Web run completed without required SSE event type: ${type}`);
    }
  }
}

function assertNonEmptyFinalWithoutFixture(
  collector: EventCollector,
  eventBoundary: number,
  marker: string,
  nonce: string,
  context: { caseName: 'completed' | 'active'; phase: 'parent' | 'child' }
): void {
  const finalText = collector.events
    .slice(eventBoundary)
    .filter((event) => event.type === 'message.delta')
    .map((event) => event.properties.delta)
    .filter((delta): delta is string => typeof delta === 'string')
    .join('');
  if (!finalText.trim()) throw new Error('Qualification final response is empty');
  const containsMarker = finalText.includes(marker);
  const containsNonce = finalText.includes(nonce);
  if (containsMarker || containsNonce) {
    throw new Error(
      `Qualification final response exposed fixture material: ${JSON.stringify({
        case: context.caseName,
        phase: context.phase,
        textLength: finalText.length,
        containsMarker,
        containsNonce,
        hash: createHash('sha256').update(finalText).digest('hex'),
      })}`
    );
  }
}

function assertStrictParent(events: readonly SessionEvent[], memoryPath: string): void {
  assertForkParentToolTrace(extractDurableToolTrace(events), memoryPath);
}

function assertStrictChild(
  events: readonly SessionEvent[],
  boundary: number,
  resultPath: string,
  expectedBytes: string
): void {
  assertForkChildToolTrace(
    extractDurableToolTrace(events, { afterEventCount: boundary }),
    resultPath,
    expectedBytes
  );
}

function assertForkEventIdsAreIndependent(
  parentEvents: readonly SessionEvent[],
  childEvents: readonly SessionEvent[]
): void {
  const parentEventIds = new Set(parentEvents.map((event) => event.id));
  if (childEvents.some((event) => parentEventIds.has(event.id))) {
    throw new Error('Fork child reused a parent durable event identity');
  }
}

function parentPrompt(): string {
  return [
    'Use the Read tool to read the workspace file memory.txt.',
    'Remember its complete contents for a later fork.',
    'Only Read is allowed. Exact retries are acceptable.',
    'Never repeat, quote, encode, summarize, or otherwise expose any file contents.',
    'After Read succeeds, reply with exactly READ_COMPLETE and nothing else.',
  ].join(' ');
}

function childPrompt(): string {
  return [
    'The immediately preceding pending parent request is superseded by this newer request.',
    'Do not answer the pending acknowledgment request.',
    'Recover the complete marker only from the inherited Read result.',
    'Use Write to create result.txt with that exact marker and exactly one trailing newline.',
    'Then use Bash with exactly this command: wc -c result.txt',
    'Only exact retries of those two calls are allowed.',
    'Do not repeat the marker in final prose; reply with exactly CHILD_COMPLETE.',
  ].join(' ');
}

async function runChildTurn(
  server: TestServer,
  child: SessionRef,
  childSnapshot: readonly SessionEvent[],
  parentBeforeFork: string,
  parentPath: string,
  fixture: ForkFixture,
  expectedBytes: string,
  marker: string,
  caseName: 'completed' | 'active'
): Promise<{ collector: EventCollector; raw: string }> {
  const collector = await collectEvents(server, child);
  const resultPath = path.join(fixture.workspace, 'result.txt');
  try {
    const eventBoundary = collector.events.length;
    const accepted = await sendMessage(server, child, childPrompt());
    await waitForRunCompletion(server, child, collector, accepted.runId, eventBoundary);
    const childPath = findSessionTranscript(fixture.storageRoot, child.sessionId);
    const events = readSessionEvents(childPath);
    const raw = readFileSync(childPath, 'utf8');
    assertStrictChild(events, childSnapshot.length, resultPath, expectedBytes);
    assertSurfaceEventTypes(collector, eventBoundary, [
      'turn.started',
      'tool.start',
      'tool.result',
    ]);
    if (readFileSync(resultPath, 'utf8') !== expectedBytes) {
      throw new Error('Web fork child result bytes violated the exact contract');
    }
    assertNonEmptyFinalWithoutFixture(collector, eventBoundary, marker, fixture.nonce, {
      caseName,
      phase: 'child',
    });
    assertCollectorIdentity(collector, child);
    assertParentUnchanged(parentBeforeFork, parentPath);
    expect(events.length).toBeGreaterThan(childSnapshot.length);
    expect(collector.events.map((event) => event.type)).not.toContain('run.cancelled');
    return { collector, raw };
  } catch (error) {
    await collector.close();
    throw error;
  }
}

const describeWebTrajectory = enabled ? describe.sequential : describe.skip;

describeWebTrajectory('Web durable fork trajectories (real API)', () => {
  if (modelConfigs.length === 0) {
    it('requires REAL_API_TEST=1', () => undefined);
  }

  for (const [modelIndex, modelConfig] of modelConfigs.entries()) {
    const modelLabel = safeModelLabel(modelConfig, modelIndex);

    it(`${modelLabel} forks a completed parent through HTTP and SSE`, async () => {
      const fixture = createForkFixture('web-completed', modelLabel);
      const marker = `WEB_COMPLETED_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      let server: TestServer | undefined;
      let parent: SessionRef | undefined;
      let child: SessionRef | undefined;
      let parentCollector: EventCollector | undefined;
      let childCollector: EventCollector | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        getState().config.actions.setConfig(
          createResolvedConfig(modelConfig, ['Read'])
        );
        writeFileSync(memoryPath, expectedBytes);
        const activeServer = await BladeServer.listenAsync({
          port: 0,
          hostname: '127.0.0.1',
        });
        server = activeServer;

        parent = await createSession(activeServer, fixture.workspace);
        await listSession(activeServer, parent);
        parentCollector = await collectEvents(activeServer, parent);
        const parentEventBoundary = parentCollector.events.length;
        const accepted = await sendMessage(activeServer, parent, parentPrompt());
        await waitForRunCompletion(
          activeServer,
          parent,
          parentCollector,
          accepted.runId,
          parentEventBoundary
        );
        assertSurfaceEventTypes(parentCollector, parentEventBoundary, [
          'turn.started',
          'tool.start',
          'tool.result',
        ]);

        const parentPath = findSessionTranscript(fixture.storageRoot, parent.sessionId);
        const parentEvents = readSessionEvents(parentPath);
        const parentBeforeFork = readFileSync(parentPath, 'utf8');
        assertStrictParent(parentEvents, memoryPath);
        assertNonEmptyFinalWithoutFixture(
          parentCollector,
          parentEventBoundary,
          marker,
          fixture.nonce,
          { caseName: 'completed', phase: 'parent' }
        );
        const forked = await forkSession(activeServer, parent);
        child = forked.ref;
        assertParentUnchanged(parentBeforeFork, parentPath);
        const childPath = findSessionTranscript(fixture.storageRoot, child.sessionId);
        const childSnapshot = readSessionEvents(childPath);
        assertForkLineage(childSnapshot, {
          childId: child.sessionId,
          parentId: parent.sessionId,
          rootId: parent.sessionId,
        });
        assertForkEventIdsAreIndependent(parentEvents, childSnapshot);
        expect(extractDurableToolTrace(childSnapshot)).toEqual(
          extractDurableToolTrace(parentEvents)
        );
        expect(forked.response.messages.length).toBeGreaterThan(0);

        rmSync(memoryPath);
        if (existsSync(memoryPath)) {
          throw new Error('Source memory still exists before the child turn');
        }
        getState().config.actions.setConfig(
          createResolvedConfig(modelConfig, ['Write', 'Bash'])
        );
        const childRun = await runChildTurn(
          activeServer,
          child,
          childSnapshot,
          parentBeforeFork,
          parentPath,
          fixture,
          expectedBytes,
          marker,
          'completed'
        );
        childCollector = childRun.collector;
        assertNoSecrets(
          {
            parentHttp: accepted,
            forkHttp: forked.response,
            parentSse: parentCollector.events,
            childSse: childCollector.events,
            parentRaw: parentBeforeFork,
            childRaw: childRun.raw,
          },
          [modelConfig.apiKey]
        );
        assertCollectorIdentity(parentCollector, parent);
        expect(parentCollector.events.map((event) => event.type)).not.toContain(
          'run.cancelled'
        );
      } finally {
        await childCollector?.close().catch(() => undefined);
        await parentCollector?.close().catch(() => undefined);
        if (server && child) await deleteSession(server, child).catch(() => undefined);
        if (server && parent)
          await deleteSession(server, parent).catch(() => undefined);
        await server?.stop().catch(() => undefined);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        cleanupForkFixture(fixture);
      }
    }, 420_000);

    it(`${modelLabel} forks a stable prefix while the parent provider response is held`, async () => {
      const fixture = createForkFixture('web-active', modelLabel);
      const marker = `WEB_ACTIVE_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      let server: TestServer | undefined;
      let proxy: Awaited<ReturnType<typeof startHeldProviderProxy>> | undefined;
      let parent: SessionRef | undefined;
      let child: SessionRef | undefined;
      let parentCollector: EventCollector | undefined;
      let childCollector: EventCollector | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        getState().config.actions.setConfig(
          createResolvedConfig(modelConfig, ['Read'])
        );
        writeFileSync(memoryPath, expectedBytes);
        const activeServer = await BladeServer.listenAsync({
          port: 0,
          hostname: '127.0.0.1',
        });
        server = activeServer;

        parent = await createSession(activeServer, fixture.workspace);
        await listSession(activeServer, parent);
        parentCollector = await collectEvents(activeServer, parent);
        const firstSseBoundary = parentCollector.events.length;
        const firstAccepted = await sendMessage(activeServer, parent, parentPrompt());
        await waitForRunCompletion(
          activeServer,
          parent,
          parentCollector,
          firstAccepted.runId,
          firstSseBoundary
        );
        assertSurfaceEventTypes(parentCollector, firstSseBoundary, [
          'turn.started',
          'tool.start',
          'tool.result',
        ]);
        assertNonEmptyFinalWithoutFixture(
          parentCollector,
          firstSseBoundary,
          marker,
          fixture.nonce,
          { caseName: 'active', phase: 'parent' }
        );
        const parentPath = findSessionTranscript(fixture.storageRoot, parent.sessionId);
        const committedEvents = readSessionEvents(parentPath);
        assertStrictParent(committedEvents, memoryPath);

        if (!modelConfig.baseURL) {
          throw new Error('Web fork qualification provider base URL is missing');
        }
        proxy = await startHeldProviderProxy(modelConfig.baseURL);
        getState().config.actions.setConfig(
          createResolvedConfig(modelConfig, ['Read'], {
            baseURL: proxy.baseUrl,
            idSuffix: 'held',
          })
        );
        const secondSseBoundary = parentCollector.events.length;
        const secondAccepted = await sendMessage(
          activeServer,
          parent,
          [
            'If a later user message exists, it supersedes this request completely.',
            'Otherwise reply with a short acknowledgment.',
            'Do not call tools.',
          ].join(' ')
        );
        await parentCollector.waitFor((event) => event.type === 'turn.started', {
          afterIndex: secondSseBoundary,
          label: 'turn.started',
        });
        await proxy.requestHeld;
        expect(await getStatus(activeServer, parent)).toEqual({
          sessionId: parent.sessionId,
          projectPath: parent.projectPath,
          runId: secondAccepted.runId,
          status: 'running',
        });

        const boundaryRaw = readFileSync(parentPath, 'utf8');
        if (!boundaryRaw.endsWith('\n')) {
          throw new Error('Active parent committed prefix is not newline terminated');
        }
        const boundaryEvents = readSessionEvents(parentPath);
        const forked = await forkSession(activeServer, parent);
        child = forked.ref;
        assertParentUnchanged(boundaryRaw, parentPath);
        expect(parentCollector.events.map((event) => event.type)).not.toContain(
          'run.cancelled'
        );
        const childPath = findSessionTranscript(fixture.storageRoot, child.sessionId);
        const childSnapshot = readSessionEvents(childPath);
        assertForkLineage(childSnapshot, {
          childId: child.sessionId,
          parentId: parent.sessionId,
          rootId: parent.sessionId,
        });
        assertForkEventIdsAreIndependent(boundaryEvents, childSnapshot);
        expect(extractDurableToolTrace(childSnapshot)).toEqual(
          extractDurableToolTrace(boundaryEvents)
        );

        proxy.release();
        await waitForRunCompletion(
          activeServer,
          parent,
          parentCollector,
          secondAccepted.runId,
          secondSseBoundary
        );
        const completedParentRaw = readFileSync(parentPath, 'utf8');
        const completedParentEvents = readSessionEvents(parentPath);
        expect(completedParentRaw.startsWith(boundaryRaw)).toBe(true);
        expect(completedParentRaw.length).toBeGreaterThan(boundaryRaw.length);
        assertForkSnapshotExcludesParentSuffix(
          childSnapshot,
          boundaryEvents.length,
          completedParentEvents
        );
        expect(
          parentCollector.events
            .slice(secondSseBoundary)
            .some((event) => event.type === 'tool.start')
        ).toBe(false);
        expect(parentCollector.events.map((event) => event.type)).not.toContain(
          'run.cancelled'
        );

        rmSync(memoryPath);
        if (existsSync(memoryPath)) {
          throw new Error('Source memory still exists before the active child turn');
        }
        getState().config.actions.setConfig(
          createResolvedConfig(modelConfig, ['Write', 'Bash'])
        );
        const childRun = await runChildTurn(
          activeServer,
          child,
          childSnapshot,
          completedParentRaw,
          parentPath,
          fixture,
          expectedBytes,
          marker,
          'active'
        );
        childCollector = childRun.collector;
        assertNoSecrets(
          {
            firstHttp: firstAccepted,
            secondHttp: secondAccepted,
            forkHttp: forked.response,
            status: await getStatus(activeServer, parent),
            proxy: proxy.redactedEvidence(),
            parentSse: parentCollector.events,
            childSse: childCollector.events,
            parentRaw: completedParentRaw,
            childRaw: childRun.raw,
          },
          [modelConfig.apiKey]
        );
        assertCollectorIdentity(parentCollector, parent);
      } finally {
        proxy?.release();
        await proxy?.close().catch(() => undefined);
        await childCollector?.close().catch(() => undefined);
        await parentCollector?.close().catch(() => undefined);
        if (server && child) await deleteSession(server, child).catch(() => undefined);
        if (server && parent)
          await deleteSession(server, parent).catch(() => undefined);
        await server?.stop().catch(() => undefined);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        cleanupForkFixture(fixture);
      }
    }, 480_000);
  }
});
