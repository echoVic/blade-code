import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { buildBackgroundSubagentCompletion } from '../../../src/agent/subagents/BackgroundSubagentCompletion.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { runBackgroundSubagentCompletionAcpDriver } from '../../support/backgroundSubagentCompletionAcpDriver.js';
import { runBackgroundSubagentCompletionPtyDriver } from '../../support/backgroundSubagentCompletionPtyDriver.js';
import { runBackgroundSubagentCompletionWebDriver } from '../../support/backgroundSubagentCompletionWebDriver.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import { runWeightedProviderAdmissionPtyDriver } from '../../support/weightedProviderAdmissionPtyDriver.js';
import {
  type BackgroundSubagentCompletionFixture,
  resetBackgroundCompletionRuntimeState,
  seedBackgroundSubagentCompletionFixture,
  writeBackgroundCompletionAgent,
} from './backgroundSubagentCompletionFixture.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  isReleaseMatrix,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const originalProviderBaseUrl = process.env.BLADE_BASE_URL;
let originalConfig: RuntimeConfig | null = null;

interface PreparedFixture {
  surface: 'headless' | 'acp' | 'pty' | 'web';
  root: string;
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  fixture: BackgroundSubagentCompletionFixture;
  proxy: RecordingProviderProxy;
  secret: string;
}

function modelMarker(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_');
}

async function prepareFixture(
  model: (typeof models)[number],
  surface: 'headless' | 'acp' | 'pty' | 'web',
  options: {
    providerRequestConcurrency?: number;
    providerRequestPendingBytes?: number;
    proxyOptions?: Parameters<typeof startRecordingProviderProxy>[1];
  } = {}
): Promise<PreparedFixture> {
  if (!model.baseURL) throw new Error(`Missing Provider base URL for ${model.model}`);
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-bg-completion-${surface}-`));
  const workspace = path.join(root, 'project');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const defaultProxyOptions =
    surface === 'acp'
      ? {}
      : options.providerRequestPendingBytes !== undefined
        ? {
            holdRequestNumber: 2,
            holdMs: surface === 'pty' ? 60_000 : 10_000,
          }
        : {
            holdBodyIncludes: 'Call Read exactly once on the requested marker file.',
            holdMs: 10_000,
          };
  const proxy = await startRecordingProviderProxy(model.baseURL, {
    ...defaultProxyOptions,
    ...(options.proxyOptions ?? {}),
  });
  const providerRequestConcurrency = options.providerRequestConcurrency ?? 1;
  const baseConfig = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl });
  const config: RuntimeConfig = {
    ...baseConfig,
    models: baseConfig.models.map((entry) => ({
      ...entry,
      overrides: {
        ...entry.overrides,
        maxRetries: 0,
      },
    })),
    permissionMode: PermissionMode.YOLO,
    maxTurns: 12,
    providerRequestConcurrency,
    providerRequestAdmissionMs: 120_000,
    providerForegroundRecoveryMs: 0,
    ...(options.providerRequestPendingBytes !== undefined
      ? { providerRequestPendingBytes: options.providerRequestPendingBytes }
      : {}),
  };
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
  ]);
  await writeBackgroundCompletionAgent(workspace);
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        permissionMode: PermissionMode.YOLO,
        maxTurns: 12,
        providerRequestConcurrency,
        providerRequestAdmissionMs: 120_000,
        providerForegroundRecoveryMs: 0,
        ...(options.providerRequestPendingBytes !== undefined
          ? { providerRequestPendingBytes: options.providerRequestPendingBytes }
          : {}),
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  process.env.BLADE_STORAGE_ROOT = storageRoot;
  process.env.BLADE_BASE_URL = proxy.baseUrl;
  resetBackgroundCompletionRuntimeState();
  WorkspaceTrustService.resetInstance();
  await WorkspaceTrustService.getInstance().trust(workspace);
  getState().config.actions.setConfig(config);

  const suffix = `${surface.toUpperCase()}_${modelMarker(model.model)}_${Date.now()}`;
  const sessionId = `background-completion-${surface}-${model.model}-${Date.now()}`;
  const fixture = await runWithCwdOverride(workspace, () =>
    seedBackgroundSubagentCompletionFixture({
      workspace,
      sessionId,
      childMarker: `BACKGROUND_CHILD_${suffix}`,
      independentMarker: `PARENT_INDEPENDENT_${suffix}`,
      modelId: config.currentModelId,
      ...(options.providerRequestPendingBytes !== undefined
        ? { requestPaddingBytes: 40 * 1024 }
        : {}),
    })
  );
  resetBackgroundCompletionRuntimeState();
  return {
    surface,
    root,
    workspace,
    storageRoot,
    home,
    sessionId,
    fixture,
    proxy,
    secret: model.apiKey,
  };
}

function toolCallEvents(events: readonly SessionEvent[], name: string) {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'part_created' }> =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_call' &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.toolName === name
  );
}

type ToolResultPartEvent = Extract<SessionEvent, { type: 'part_created' }> & {
  data: Extract<SessionEvent, { type: 'part_created' }>['data'] & {
    payload: Record<string, unknown>;
  };
};

function toolResultEvents(events: readonly SessionEvent[], name: string) {
  return events.filter(
    (event): event is ToolResultPartEvent =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.toolName === name
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadChatContext(
  sessionId: string,
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<ChatContext> {
  return {
    messages: await SessionService.loadSession(sessionId, workspaceRoot),
    userId: 'real-background-subagent-completion',
    sessionId,
    workspaceRoot,
    permissionMode: PermissionMode.YOLO,
    ...(signal ? { signal } : {}),
  };
}

function getChildSidecarPath(input: PreparedFixture, childSessionId: string): string {
  return path.join(input.storageRoot, 'agents', 'sessions', `${childSessionId}.json`);
}

async function collectFailureDiagnostic(input: PreparedFixture): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const events =
    (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
  const children = AgentSessionStore.getInstance()
    .listSessions()
    .filter(
      (session) =>
        session.parentSessionId === input.sessionId &&
        session.parentProjectPath === input.workspace
    )
    .map((session) => ({
      id: session.id,
      status: session.status,
      background: session.background,
      rootAgentId: session.rootAgentId,
      resumeDepth: session.resumeDepth,
      resultSuccess: session.result?.success,
      resultHasMarker: session.result?.message.includes(input.fixture.childMarker),
    }));
  const taskPayload = toolCallEvents(events, 'Task')[0]?.data.payload as
    | { input?: Record<string, unknown> }
    | undefined;
  const child = AgentSessionStore.getInstance()
    .listSessions()
    .find(
      (session) =>
        session.parentSessionId === input.sessionId &&
        session.parentProjectPath === input.workspace
    );
  const diagnostic = {
    taskCalls: toolCallEvents(events, 'Task').length,
    taskOutputCalls: toolCallEvents(events, 'TaskOutput').length,
    parentReads: toolCallEvents(events, 'Read').length,
    hiddenReceipts: events.filter(
      (event) =>
        event.type === 'message_created' &&
        event.data.inboxMessageId?.startsWith('background-subagent-completion:')
    ).length,
    completionAcks: events.filter(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.some((id) =>
          id.startsWith('background-subagent-completion:')
        )
    ).length,
    turnCompletions: events.filter((event) => event.type === 'turn_completed').length,
    taskInput: taskPayload?.input,
    completionBuilds: child
      ? Boolean(
          buildBackgroundSubagentCompletion(child, {
            sessionId: input.sessionId,
            projectPath: input.workspace,
          })
        )
      : false,
    children,
    providerRequests: input.proxy.requestBodies.length,
  };
  return JSON.stringify(diagnostic).replaceAll(input.secret, '[REDACTED]');
}

async function assertBackgroundCompletion(
  input: PreparedFixture,
  options: {
    expectedMaxInFlight?: number | null;
    minHeldRequestDurationMs?: number | null;
  } = {}
): Promise<void> {
  expect(input.proxy.requestBodies.length).toBeGreaterThanOrEqual(3);
  if (input.surface !== 'acp') {
    const expectedMaxInFlight =
      options.expectedMaxInFlight === undefined ? 1 : options.expectedMaxInFlight;
    if (expectedMaxInFlight !== null) {
      expect(input.proxy.maxInFlight).toBe(expectedMaxInFlight);
    }
    expect(input.proxy.heldRequestNumbers).toHaveLength(1);
    const heldRequestIndex = (input.proxy.heldRequestNumbers[0] ?? 0) - 1;
    const minHeldRequestDurationMs =
      options.minHeldRequestDurationMs === undefined
        ? 9_500
        : options.minHeldRequestDurationMs;
    if (minHeldRequestDurationMs !== null) {
      expect(
        (input.proxy.requestFinishedAt[heldRequestIndex] ?? 0) -
          (input.proxy.requestStartedAt[heldRequestIndex] ?? 0)
      ).toBeGreaterThanOrEqual(minHeldRequestDurationMs);
    }
  }
  await expect(
    access(getSessionInboxFilePath(input.workspace, input.sessionId))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(input.fixture.childMarkerPath, 'utf8')).toBe(
    `${input.fixture.childMarker}\n`
  );
  expect(await readFile(input.fixture.independentMarkerPath, 'utf8')).toBe(
    `${input.fixture.independentMarker}\n`
  );

  const persistentStore = new PersistentStore(input.workspace);
  let events = await persistentStore.loadEvents(input.sessionId);
  if (!events) throw new Error('Background completion parent transcript is missing');
  const taskCalls = toolCallEvents(events, 'Task');
  const taskOutputCalls = toolCallEvents(events, 'TaskOutput');
  const parentReads = toolCallEvents(events, 'Read');
  const runningResults = toolResultEvents(events, 'Task').filter((event) => {
    const value = event.data.payload.metadata;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const metadata = value as Record<string, unknown>;
    return (
      metadata.background === true && typeof metadata.subagentSessionId === 'string'
    );
  });
  expect(runningResults, 'expected one admitted background Task launch').toHaveLength(
    1
  );
  expect(taskOutputCalls).toHaveLength(0);
  expect(
    parentReads.length,
    'expected the parent to perform independent work while the child runs'
  ).toBeGreaterThanOrEqual(1);
  for (const parentRead of parentReads) {
    const payload = parentRead.data.payload as {
      input?: { file_path?: unknown };
    };
    expect(typeof payload.input?.file_path).toBe('string');
    expect(
      await realpath(path.resolve(input.workspace, String(payload.input?.file_path)))
    ).toBe(await realpath(input.fixture.independentMarkerPath));
  }
  const runningMetadata = (
    runningResults[0]!.data.payload as {
      metadata: { subagentSessionId: string };
    }
  ).metadata;
  const childSessionId = runningMetadata.subagentSessionId;
  const launchedTaskCalls = taskCalls.filter((event) => {
    const payload = event.data.payload as { input?: Record<string, unknown> };
    return payload.input?.subagent_session_id === childSessionId;
  });
  expect(launchedTaskCalls).toHaveLength(1);
  const taskInput = launchedTaskCalls[0]!.data.payload as {
    input?: Record<string, unknown>;
  };
  expect(taskInput.input).toMatchObject({
    run_in_background: true,
  });
  expect(runningResults[0]!.seq).toBeTypeOf('number');
  expect(parentReads[0]!.seq).toBeGreaterThan(runningResults[0]!.seq ?? 0);

  const completionInboxId = `background-subagent-completion:${childSessionId}`;
  const completionMessages = events.filter(
    (event) =>
      event.type === 'message_created' &&
      event.data.inboxMessageId === completionInboxId &&
      event.data.role === 'user' &&
      event.data.metadata !== null &&
      typeof event.data.metadata === 'object' &&
      !Array.isArray(event.data.metadata) &&
      event.data.metadata.clientVisible === false
  );
  expect(completionMessages, 'expected one hidden completion receipt').toHaveLength(1);
  expect(JSON.stringify(completionMessages)).toContain(input.fixture.childMarker);
  expect(
    events.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'subtask_ref' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.childSessionId === childSessionId &&
        event.data.payload.status === 'completed'
    ),
    'expected one completed subtask projection'
  ).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes(completionInboxId)
    ),
    'expected one completion inbox acknowledgement'
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === 'turn_completed').length
  ).toBeGreaterThan(0);

  const visibleMessages = SessionService.toUISafeMessages(
    SessionService.convertJSONLToMessages(events)
  );
  expect(
    visibleMessages.filter(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes(input.fixture.childMarker)
    )
  ).toHaveLength(0);
  expect(
    visibleMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        JSON.stringify(message.content).includes(
          `BACKGROUND_PARENT_FINAL:${input.fixture.childMarker}`
        )
    ),
    'expected one visible parent final'
  ).toHaveLength(1);

  resetBackgroundCompletionRuntimeState();
  const children = AgentSessionStore.getInstance()
    .listSessions()
    .filter(
      (session) =>
        session.parentSessionId === input.sessionId &&
        session.parentProjectPath === input.workspace
    );
  expect(children).toEqual([
    expect.objectContaining({
      id: childSessionId,
      background: true,
      status: 'completed',
      rootAgentId: childSessionId,
      resumeDepth: 0,
      result: expect.objectContaining({
        success: true,
        message: expect.stringContaining(input.fixture.childMarker),
      }),
    }),
  ]);
  const sidecarPath = path.join(
    input.storageRoot,
    'agents',
    'sessions',
    `${childSessionId}.json`
  );
  const sidecarBeforeColdStart = await readFile(sidecarPath, 'utf8');
  const coldRuntime = await SessionRuntime.create({
    sessionId: input.sessionId,
    workspaceRoot: input.workspace,
  });
  await coldRuntime.dispose();
  expect(await readFile(sidecarPath, 'utf8')).toBe(sidecarBeforeColdStart);
  events = (await persistentStore.loadEvents(input.sessionId)) ?? [];
  expect(
    events.filter(
      (event) =>
        event.type === 'message_created' &&
        event.data.inboxMessageId === completionInboxId
    )
  ).toHaveLength(1);

  expect(input.fixture.parentPrompt).not.toContain(input.fixture.childMarker);
  expect(input.proxy.requestBodies.length).toBeGreaterThanOrEqual(3);
  expect(input.proxy.requestBodies[0]).not.toContain(input.fixture.childMarker);
  const markerRequests = input.proxy.requestBodies.filter((body) =>
    body.includes(input.fixture.childMarker)
  );
  expect(
    markerRequests.some((body) => body.includes('background-subagent-completion'))
  ).toBe(true);
  expect(
    markerRequests.some((body) => !body.includes('background-subagent-completion'))
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain(input.secret);
  expect(JSON.stringify(input.proxy.requestBodies)).not.toContain(input.secret);
}

async function cleanupFixture(input: PreparedFixture): Promise<void> {
  resetBackgroundCompletionRuntimeState();
  WorkspaceTrustService.resetInstance();
  await input.proxy.close().catch(() => undefined);
  await rm(input.root, { recursive: true, force: true });
  if (originalProviderBaseUrl === undefined) {
    delete process.env.BLADE_BASE_URL;
  } else {
    process.env.BLADE_BASE_URL = originalProviderBaseUrl;
  }
}

beforeAll(() => {
  if (models.length > 0) originalConfig = getState().config.config;
});

afterAll(() => {
  resetBackgroundCompletionRuntimeState();
  WorkspaceTrustService.resetInstance();
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
  if (originalProviderBaseUrl === undefined) {
    delete process.env.BLADE_BASE_URL;
  } else {
    process.env.BLADE_BASE_URL = originalProviderBaseUrl;
  }
});

describe
  .skipIf(models.length === 0)
  .sequential('durable background-subagent completion wake-up (real API)', () => {
    for (const model of models) {
      it(`${model.model} wakes the Headless parent without polling`, async () => {
        const prepared = await prepareFixture(model, 'headless');
        let stdout = '';
        let stderr = '';
        try {
          const exitCode = await runWithCwdOverride(prepared.workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: prepared.sessionId,
                maxTurns: 8,
                permissionMode: PermissionMode.YOLO,
                allowedTools: ['Task', 'Read'],
              },
              {
                stdout: {
                  write(chunk: string) {
                    stdout += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    stderr += chunk;
                    return true;
                  },
                },
              },
              { stdin: Readable.from([]) as NodeJS.ReadStream }
            )
          );
          expect(exitCode, stderr.replaceAll(model.apiKey, '[redacted]')).toBe(0);
          const events = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          const text = events
            .flatMap((event) =>
              event.type === 'content_delta'
                ? [event.delta]
                : event.type === 'content'
                  ? [event.content]
                  : []
            )
            .join('');
          const expected = `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`;
          if (!text.includes(expected)) {
            throw new Error(
              `Headless parent did not consume background completion: ${await collectFailureDiagnostic(
                prepared
              )}`
            );
          }
          expect(
            events.filter(
              (event) => event.type === 'tool_start' && event.tool_name === 'TaskOutput'
            )
          ).toHaveLength(0);
          expect(
            events.some(
              (event) => event.type === 'provider_admission' && event.phase === 'queued'
            )
          ).toBe(true);
          expect(
            events.some(
              (event) =>
                event.type === 'provider_admission' && event.phase === 'admitted'
            )
          ).toBe(true);
          expect(`${stdout}\n${stderr}`).not.toContain(model.apiKey);
          await assertBackgroundCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it(`${model.model} transfers a running background completion across Runtime replacement`, {
        retry: 0,
        timeout: 300_000,
      }, async () => {
        const childProviderHoldMarker =
          'Return only its exact trimmed text and no explanation.';
        const childProviderHeld = createDeferred<number>();
        const releaseParentWait = createDeferred<boolean>();
        const prepared = await prepareFixture(model, 'headless', {
          providerRequestConcurrency: 2,
          proxyOptions: {
            holdBodyIncludes: childProviderHoldMarker,
            holdMs: 120_000,
            onHold: async (requestNumber) => {
              childProviderHeld.resolve(requestNumber);
            },
          },
        });
        let runtimeA: SessionRuntime | undefined;
        let runtimeB: SessionRuntime | undefined;
        let agentA: Agent | undefined;
        let agentB: Agent | undefined;
        let busUnsubscribe: (() => void) | undefined;
        let parentWaitSpy: { mockRestore(): void } | undefined;
        try {
          runtimeA = await runWithCwdOverride(prepared.workspace, () =>
            SessionRuntime.create({
              sessionId: prepared.sessionId,
              workspaceRoot: prepared.workspace,
            })
          );
          agentA = await Agent.createWithRuntime(runtimeA, {
            sessionId: runtimeA.sessionId,
            toolWhitelist: ['Task', 'Read'],
            permissionMode: PermissionMode.YOLO,
            maxTurns: 8,
          });
          const runningTaskResult = createDeferred<{ childSessionId: string }>();
          const parentWaitEntered = createDeferred<void>();
          const parentEvents: LoopEvent[] = [];
          let observedChildSessionId: string | undefined;
          parentWaitSpy = vi
            .spyOn(runtimeA, 'waitForBackgroundSubagentFollowUp')
            .mockImplementation(async () => {
              parentWaitEntered.resolve();
              return releaseParentWait.promise;
            });

          const parentRunPromise = drainLoop(
            agentA.chatStream(
              '',
              await loadChatContext(prepared.sessionId, prepared.workspace),
              {
                stream: true,
                pendingInputOnly: true,
              }
            ),
            async (event) => {
              parentEvents.push(event);
              if (event.kind !== 'tool_result') return;
              const metadata = event.result.metadata;
              if (
                metadata === null ||
                typeof metadata !== 'object' ||
                Array.isArray(metadata) ||
                metadata.background !== true ||
                typeof metadata.subagentSessionId !== 'string'
              ) {
                return;
              }
              observedChildSessionId = metadata.subagentSessionId;
              runningTaskResult.resolve({
                childSessionId: metadata.subagentSessionId,
              });
            }
          );

          let reachedParentWait: boolean;
          try {
            reachedParentWait = await withTimeout(
              Promise.race([
                parentWaitEntered.promise.then(() => true),
                parentRunPromise.then(() => false),
              ]),
              60_000,
              'Runtime A did not reach a terminal model-loop boundary'
            );
          } catch {
            throw new Error(
              `Runtime A did not reach the background wait boundary: ${await collectFailureDiagnostic(
                prepared
              )}; loopEvents=${JSON.stringify(
                parentEvents.map((event) => event.kind)
              )}; providerLifecycle=${JSON.stringify(prepared.proxy.requestLifecycle)}`
            );
          }
          if (!reachedParentWait) {
            const earlyResult = await parentRunPromise;
            const earlyFailure = {
              success: earlyResult.success,
              finalMessage: earlyResult.finalMessage,
              errorType: earlyResult.error?.type,
              errorMessage: earlyResult.error?.message,
              metadata: earlyResult.metadata,
            };
            throw new Error(
              `Runtime A settled before the background wait boundary: ${await collectFailureDiagnostic(
                prepared
              )}; loopEvents=${JSON.stringify(
                parentEvents.map((event) => event.kind)
              )}; providerLifecycle=${JSON.stringify(prepared.proxy.requestLifecycle)}; result=${JSON.stringify(
                earlyFailure
              ).replaceAll(prepared.secret, '[REDACTED]')}`
            );
          }
          if (!observedChildSessionId) {
            throw new Error(
              `Runtime A completed its model loop without a background Task result: ${await collectFailureDiagnostic(
                prepared
              )}; loopEvents=${JSON.stringify(
                parentEvents.map((event) => event.kind)
              )}; providerLifecycle=${JSON.stringify(prepared.proxy.requestLifecycle)}`
            );
          }
          const heldRequestNumber = await withTimeout(
            childProviderHeld.promise,
            60_000,
            'Background child Provider request never reached the hold barrier'
          );
          if (heldRequestNumber === 1) {
            throw new Error(
              'Background child hold marker matched the parent Provider request'
            );
          }
          const [{ childSessionId }] = await Promise.all([
            withTimeout(
              runningTaskResult.promise,
              60_000,
              'Background Task running result did not arrive before replacement'
            ),
          ]);
          const completionInboxId = `background-subagent-completion:${childSessionId}`;
          const childSidecarPath = getChildSidecarPath(prepared, childSessionId);
          const childSidecarWhileHeld = JSON.parse(
            await readFile(childSidecarPath, 'utf8')
          ) as Record<string, unknown>;
          const eventsBeforeReplacement =
            (await new PersistentStore(prepared.workspace).loadEvents(
              prepared.sessionId
            )) ?? [];

          expect(parentWaitSpy).toHaveBeenCalledTimes(1);
          expect(
            SessionService.convertJSONLToMessages(eventsBeforeReplacement)
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: 'assistant',
                content: 'WAITING_FOR_BACKGROUND_COMPLETION',
              }),
            ])
          );
          expect(
            eventsBeforeReplacement.filter((event) => event.type === 'turn_completed')
          ).toHaveLength(0);
          expect(
            eventsBeforeReplacement.filter((event) => event.type === 'turn_aborted')
          ).toHaveLength(0);
          expect(JSON.stringify(eventsBeforeReplacement)).not.toContain(
            `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`
          );
          expect(childSidecarWhileHeld).toMatchObject({
            id: childSessionId,
            status: 'running',
            background: true,
            rootAgentId: childSessionId,
            resumeDepth: 0,
          });
          expect(parentEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: 'tool_result',
              }),
            ])
          );
          expect(prepared.proxy.requestLifecycle).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                requestNumber: heldRequestNumber,
                phase: 'hold_entered',
              }),
            ])
          );
          expect(
            parentEvents.filter(
              (event) =>
                event.kind === 'tool_start' &&
                event.toolCall.function.name === 'TaskOutput'
            )
          ).toHaveLength(0);
          expect(
            prepared.proxy.requestLifecycle.some(
              (entry) =>
                entry.requestNumber === heldRequestNumber &&
                ['release_observed', 'body_completed', 'downstream_ended'].includes(
                  entry.phase
                )
            )
          ).toBe(false);
          expect(
            prepared.proxy.requestBodies.filter((body) =>
              body.includes(childProviderHoldMarker)
            )
          ).toHaveLength(1);

          releaseParentWait.resolve(false);
          const parentRunResult = await withTimeout(
            parentRunPromise,
            60_000,
            'Runtime A pending parent loop did not finish after replacement gate release'
          );
          parentWaitSpy.mockRestore();
          parentWaitSpy = undefined;

          expect(parentRunResult.success).toBe(true);
          expect(parentRunResult.finalMessage).toBe(
            'WAITING_FOR_BACKGROUND_COMPLETION'
          );

          const eventsAfterTurnCompletion =
            (await new PersistentStore(prepared.workspace).loadEvents(
              prepared.sessionId
            )) ?? [];
          expect(
            eventsAfterTurnCompletion.filter((event) => event.type === 'turn_completed')
          ).toHaveLength(1);
          expect(
            eventsAfterTurnCompletion.filter((event) => event.type === 'turn_aborted')
          ).toHaveLength(0);
          expect(
            SessionService.convertJSONLToMessages(eventsAfterTurnCompletion)
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: 'assistant',
                content: 'WAITING_FOR_BACKGROUND_COMPLETION',
              }),
            ])
          );
          expect(JSON.stringify(eventsAfterTurnCompletion)).not.toContain(
            `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`
          );

          await agentA.destroy();
          agentA = undefined;
          await runtimeA.dispose();
          runtimeA = undefined;

          runtimeB = await runWithCwdOverride(prepared.workspace, () =>
            SessionRuntime.create({
              sessionId: prepared.sessionId,
              workspaceRoot: prepared.workspace,
            })
          );
          agentB = await Agent.createWithRuntime(runtimeB, {
            sessionId: runtimeB.sessionId,
            toolWhitelist: ['Task', 'Read'],
            permissionMode: PermissionMode.YOLO,
            maxTurns: 8,
          });
          expect(runtimeB.getTurnRecoveryAssessment()).toEqual({ state: 'none' });

          const busEvents: Array<Record<string, unknown>> = [];
          const busWakePromise = withTimeout(
            new Promise<void>((resolve) => {
              busUnsubscribe = Bus.subscribe((event) => {
                if (
                  event.sessionId !== prepared.sessionId ||
                  event.projectPath !== prepared.workspace ||
                  event.type !== 'subagent.completion.queued' ||
                  event.properties.childSessionId !== childSessionId
                ) {
                  return;
                }
                busEvents.push(event.properties);
                busUnsubscribe?.();
                busUnsubscribe = undefined;
                resolve();
              });
            }),
            60_000,
            'Runtime B never received the queued background completion bus wake'
          );

          expect(runtimeB.getPendingSteeringCount()).toBe(0);
          expect(
            runtimeB.getPendingSteeringMessages().map((message) => message.id)
          ).not.toContain(completionInboxId);

          prepared.proxy.releaseHeld();
          await busWakePromise;

          expect(busEvents).toEqual([
            expect.objectContaining({
              childSessionId,
              queued: 1,
              status: 'completed',
              rootAgentId: childSessionId,
              resumeDepth: 0,
            }),
          ]);
          expect(
            runtimeB
              .getPendingSteeringMessages()
              .filter((message) => message.id === completionInboxId)
          ).toEqual([
            expect.objectContaining({
              id: completionInboxId,
              origin: 'background_subagent',
              persisted: true,
              content: expect.stringContaining(prepared.fixture.childMarker),
              metadata: expect.objectContaining({
                clientVisible: false,
                backgroundSubagentCompletion: expect.objectContaining({
                  childSessionId,
                }),
              }),
            }),
          ]);

          const followUpEvents: LoopEvent[] = [];
          const contentDeltas: string[] = [];
          const runtimeBResult = await drainLoop(
            agentB.chatStream(
              '',
              await loadChatContext(prepared.sessionId, prepared.workspace),
              {
                stream: true,
                pendingInputOnly: true,
              }
            ),
            async (event) => {
              followUpEvents.push(event);
              if (event.kind === 'content_delta') {
                contentDeltas.push(event.delta);
              }
            }
          );

          expect(runtimeBResult.success).toBe(true);
          expect(runtimeBResult.finalMessage).toContain(
            `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`
          );
          expect(contentDeltas.join('')).toContain(
            `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`
          );
          expect(
            followUpEvents.filter(
              (event) =>
                event.kind === 'tool_start' &&
                event.toolCall.function.name === 'TaskOutput'
            )
          ).toHaveLength(0);
          expect(runtimeB.getPendingSteeringCount()).toBe(0);

          const childSidecarAfterCompletion = JSON.parse(
            await readFile(childSidecarPath, 'utf8')
          ) as Record<string, unknown>;
          expect(childSidecarAfterCompletion).toMatchObject({
            id: childSessionId,
            status: 'completed',
            background: true,
            rootAgentId: childSessionId,
            resumeDepth: 0,
            result: {
              success: true,
              message: expect.stringContaining(prepared.fixture.childMarker),
            },
          });
          expect(prepared.proxy.heldRequestNumbers).toHaveLength(1);
          expect(
            prepared.proxy.requestBodies.filter((body) =>
              body.includes(childProviderHoldMarker)
            )
          ).toHaveLength(2);

          await agentB.destroy();
          agentB = undefined;
          await runtimeB.dispose();
          runtimeB = undefined;

          await assertBackgroundCompletion(prepared, {
            expectedMaxInFlight: 2,
            minHeldRequestDurationMs: null,
          });
        } finally {
          releaseParentWait.resolve(false);
          parentWaitSpy?.mockRestore();
          busUnsubscribe?.();
          prepared.proxy.releaseHeld();
          await Promise.allSettled([agentA?.destroy(), agentB?.destroy()]);
          await Promise.allSettled([runtimeA?.dispose(), runtimeB?.dispose()]);
          await cleanupFixture(prepared);
        }
      });

      it(`${model.model} wakes the ACP parent without a fake user chunk`, async () => {
        const prepared = await prepareFixture(model, 'acp');
        try {
          const evidence = await runBackgroundSubagentCompletionAcpDriver({
            workspace: prepared.workspace,
            sessionId: prepared.sessionId,
            childMarker: prepared.fixture.childMarker,
            secret: model.apiKey,
          });
          expect(evidence.finalText).toContain(
            `BACKGROUND_PARENT_FINAL:${prepared.fixture.childMarker}`
          );
          expect(
            evidence.updates.filter(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('TaskOutput')
            )
          ).toHaveLength(0);
          await assertBackgroundCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it.skipIf(isReleaseMatrix())(
        `${model.model} wakes the real TUI raw PTY parent`,
        async () => {
          const prepared = await prepareFixture(model, 'pty');
          try {
            const evidence = await runBackgroundSubagentCompletionPtyDriver({
              workspace: prepared.workspace,
              storageRoot: prepared.storageRoot,
              home: prepared.home,
              sessionId: prepared.sessionId,
              childMarker: prepared.fixture.childMarker,
              secret: model.apiKey,
            });
            expect(evidence).toMatchObject({
              sawProviderAdmission: true,
              sawChildMarker: true,
              sawParentFinal: true,
            });
            await assertBackgroundCompletion(prepared);
          } finally {
            await cleanupFixture(prepared);
          }
        },
        300_000
      );

      it(`${model.model} wakes production Web GUI and survives reload`, async () => {
        const prepared = await prepareFixture(model, 'web');
        try {
          const evidence = await runBackgroundSubagentCompletionWebDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            childMarker: prepared.fixture.childMarker,
            secret: model.apiKey,
          });
          expect(evidence).toMatchObject({
            childVisible: true,
            parentVisible: true,
            noFakeUserMessage: true,
            providerAdmissionVisible: true,
            visibleAfterReload: true,
            sidecarStableAcrossReload: true,
            browserFaults: [],
          });
          await assertBackgroundCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it(`${model.model} projects an overweight background rejection in Headless`, async () => {
        const prepared = await prepareFixture(model, 'headless', {
          providerRequestPendingBytes: 64 * 1024,
        });
        let stdout = '';
        let stderr = '';
        try {
          const exitCode = await runWithCwdOverride(prepared.workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: prepared.sessionId,
                maxTurns: 8,
                permissionMode: PermissionMode.YOLO,
                allowedTools: ['Task', 'Read'],
              },
              {
                stdout: {
                  write(chunk: string) {
                    stdout += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    stderr += chunk;
                    return true;
                  },
                },
              },
              { stdin: Readable.from([]) as NodeJS.ReadStream }
            )
          );
          const events = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          expect(exitCode).toBe(0);
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'provider_admission',
                phase: 'rejected',
                request_class: 'background',
                resource: 'pending_bytes',
                reason: 'queue_full',
              }),
            ])
          );
          expect(
            events.some(
              (event) =>
                event.type === 'provider_admission' && event.phase === 'admitted'
            )
          ).toBe(false);
          expect(prepared.proxy.heldRequestNumbers).toHaveLength(1);
          expect(prepared.proxy.maxInFlight).toBe(1);
          expect(`${stdout}\n${stderr}`).not.toContain(model.apiKey);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it.skipIf(isReleaseMatrix())(
        `${model.model} renders an overweight background rejection in raw PTY`,
        async () => {
          const prepared = await prepareFixture(model, 'pty', {
            providerRequestPendingBytes: 64 * 1024,
          });
          try {
            const evidence = await runWeightedProviderAdmissionPtyDriver({
              workspace: prepared.workspace,
              storageRoot: prepared.storageRoot,
              home: prepared.home,
              sessionId: prepared.sessionId,
              secret: model.apiKey,
            });
            expect(evidence).toMatchObject({
              childFailureVisible: true,
              sidecarPendingByteFailure: true,
            });
            expect(prepared.proxy.heldRequestNumbers).toHaveLength(1);
            expect(prepared.proxy.maxInFlight).toBe(1);
          } finally {
            await cleanupFixture(prepared);
          }
        },
        300_000
      );
    }
  });
