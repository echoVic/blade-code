import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { buildBackgroundSubagentCompletion } from '../../../src/agent/subagents/BackgroundSubagentCompletion.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { runBackgroundSubagentCompletionAcpDriver } from '../../support/backgroundSubagentCompletionAcpDriver.js';
import { runBackgroundSubagentCompletionPtyDriver } from '../../support/backgroundSubagentCompletionPtyDriver.js';
import { runBackgroundSubagentCompletionWebDriver } from '../../support/backgroundSubagentCompletionWebDriver.js';
import { runWeightedProviderAdmissionPtyDriver } from '../../support/weightedProviderAdmissionPtyDriver.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
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
  options: { providerRequestPendingBytes?: number } = {}
): Promise<PreparedFixture> {
  if (!model.baseURL) throw new Error(`Missing Provider base URL for ${model.model}`);
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-bg-completion-${surface}-`));
  const workspace = path.join(root, 'project');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const proxy = await startRecordingProviderProxy(
    model.baseURL,
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
          }
  );
  const config = {
    ...buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl }),
    permissionMode: PermissionMode.YOLO,
    maxTurns: 12,
    providerRequestConcurrency: 1,
    providerRequestAdmissionMs: 120_000,
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
        providerRequestConcurrency: 1,
        providerRequestAdmissionMs: 120_000,
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

async function assertBackgroundCompletion(input: PreparedFixture): Promise<void> {
  expect(input.proxy.requestBodies.length).toBeGreaterThanOrEqual(3);
  if (input.surface !== 'acp') {
    expect(input.proxy.maxInFlight).toBe(1);
    expect(input.proxy.heldRequestNumbers).toHaveLength(1);
    const heldRequestIndex = (input.proxy.heldRequestNumbers[0] ?? 0) - 1;
    expect(
      (input.proxy.requestFinishedAt[heldRequestIndex] ?? 0) -
        (input.proxy.requestStartedAt[heldRequestIndex] ?? 0)
    ).toBeGreaterThanOrEqual(9_500);
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
  expect(taskCalls).toHaveLength(1);
  expect(taskOutputCalls).toHaveLength(0);
  expect(parentReads).toHaveLength(1);
  const taskInput = taskCalls[0]!.data.payload as {
    input?: Record<string, unknown>;
  };
  expect(taskInput.input).toMatchObject({
    run_in_background: true,
  });
  const childSessionId = taskInput.input?.subagent_session_id;
  expect(typeof childSessionId).toBe('string');
  if (typeof childSessionId !== 'string') {
    throw new Error('Background Task did not persist a child Session ID');
  }
  const runningResult = events.find(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.toolName === 'Task' &&
      event.data.payload.metadata !== null &&
      typeof event.data.payload.metadata === 'object' &&
      !Array.isArray(event.data.payload.metadata) &&
      event.data.payload.metadata.background === true
  );
  expect(runningResult?.seq).toBeTypeOf('number');
  expect(parentReads[0]!.seq).toBeGreaterThan(runningResult?.seq ?? 0);

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
  expect(completionMessages).toHaveLength(1);
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
    )
  ).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes(completionInboxId)
    )
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
    )
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

      it(`${model.model} wakes the real TUI raw PTY parent`, async () => {
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
      }, 300_000);

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

      it(`${model.model} renders an overweight background rejection in raw PTY`, async () => {
        const prepared = await prepareFixture(model, 'pty', {
          providerRequestPendingBytes: 64 * 1024,
        });
        try {
          const evidence = await runWeightedProviderAdmissionPtyDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            childMarker: prepared.fixture.childMarker,
            secret: model.apiKey,
          });
          expect(evidence).toMatchObject({
            childFailureVisible: true,
            sidecarPendingByteFailure: true,
            parentFinalVisible: true,
          });
          expect(prepared.proxy.heldRequestNumbers).toHaveLength(1);
          expect(prepared.proxy.maxInFlight).toBe(1);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);
    }
  });
