import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { type Browser, chromium, type Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import { isSessionTaskFailure } from '../../../src/context/taskFailure.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { Bus, type BusEvent } from '../../../src/server/bus.js';
import { PermissionRoutes } from '../../../src/server/routes/permission.js';
import {
  createSessionRouteController,
  type SessionRouteController,
} from '../../../src/server/routes/session.js';
import { SessionInteractionService } from '../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  createMockACPClient,
  type MockACPClient,
} from '../../support/mocks/mockACPClient.js';
import {
  type RecordingProviderProxy,
  type RecordingProviderRequestLifecycle,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import { assertNoSecrets, finalAssistantText } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  isReleaseMatrix,
  resolveForkQualificationModels,
} from './testConfig.js';

const qualificationModels = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env)
  : [];
const gpt = qualificationModels.find((model) => model.id === 'gpt');
const deepseek = qualificationModels.find((model) => model.id === 'deepseek');
const deepseekFlash = qualificationModels.find(
  (model) => model.id === 'deepseek' && model.model === 'deepseek-v4-flash'
);
if (isRealApiTestEnabled() && isReleaseMatrix() && !deepseekFlash) {
  throw new Error(
    'DeepSeek Flash is required for the production Chromium qualification'
  );
}
const describeReal = gpt && deepseek ? describe.sequential : describe.skip;

interface WebRecoveryWaitInput {
  controller: SessionRouteController;
  sessionId: string;
  projectPath: string;
  target: string;
}

const RECOVERY_DIAGNOSTIC_EVENT_TYPES = new Set([
  'interaction_requested',
  'interaction_responded',
  'interaction_recovered',
  'inbox_acknowledged',
  'turn_completed',
  'turn_aborted',
  'message_created',
  'part_created',
  'session.completed',
  'session.error',
]);

const ACP_RECOVERY_DIAGNOSTIC_EVENT_TYPES = new Set([
  'session_created',
  'session_updated',
  'turn_started',
  ...RECOVERY_DIAGNOSTIC_EVENT_TYPES,
]);
const WEB_RECOVERY_DIAGNOSTIC_TIMEOUT_MS = 1_000;
const ACP_RECOVERY_DIAGNOSTIC_TIMEOUT_MS = 1_000;
const DURABLE_INTERACTION_PROVIDER_BOUNDARIES = [
  'recovered_tool_call',
  'post_tool_final',
  'optional_empty_final_correction',
] as const;
const DURABLE_INTERACTION_PROVIDER_ATTEMPT_MS = 35_000;
const DURABLE_INTERACTION_PROVIDER_ADMISSION_MS = 5_000;
const DURABLE_INTERACTION_PROVIDER_RECOVERY_MS = 30_000;
const DURABLE_INTERACTION_WEB_WAIT_MS = 240_000;
const DURABLE_INTERACTION_ACP_WAIT_MS = 270_000;
const DURABLE_INTERACTION_STRICT_WAIT_MS = Math.min(
  DURABLE_INTERACTION_WEB_WAIT_MS,
  DURABLE_INTERACTION_ACP_WAIT_MS
);
const DURABLE_INTERACTION_FINALIZATION_RESERVE_MS = 30_000;

interface ProductionWebRecoveryEvidence {
  sseEvents: Array<{ type: string; properties: Record<string, unknown> }>;
  durableEvents: SessionEvent[];
  targetContent: string;
  targetPath: string;
  finalMarker: string;
}

interface ProductionEventProbe {
  events: ProductionWebRecoveryEvidence['sseEvents'];
  close(): Promise<void>;
}

const PRODUCTION_WEB_DIAGNOSTIC_EVENT_TYPES = new Set([
  'connected',
  'interaction.resolved',
  'message.complete',
  'pending.resume',
  'provider.retry',
  'question.required',
  'session.completed',
  'session.error',
  'session.status',
  'tool.result',
  'tool.start',
]);

type ProductionWebTerminalFailure =
  | { type: 'session.error' }
  | { type: 'pending.resume'; phase: 'failed' | 'exhausted' };

export function findProductionWebTerminalFailure(
  events: readonly ProductionWebRecoveryEvidence['sseEvents'][number][]
): ProductionWebTerminalFailure | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session.error') return { type: 'session.error' };
    if (event?.type !== 'pending.resume') continue;
    const phase = event.properties.phase;
    if (phase === 'failed' || phase === 'exhausted') {
      return { type: 'pending.resume', phase };
    }
  }
  return null;
}

const countSafeEventTypes = (types: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const type of types) {
    if (!PRODUCTION_WEB_DIAGNOSTIC_EVENT_TYPES.has(type)) continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
};

export function formatProductionWebRecoveryDiagnostic(input: {
  outcome: 'timeout' | 'terminal_failure';
  elapsedMs: number;
  sseEvents: ProductionWebRecoveryEvidence['sseEvents'];
  durableEvents: SessionEvent[];
  expectedMarker: string;
  proxyLifecycle: readonly RecordingProviderRequestLifecycle[];
  targetBytes: number | undefined;
  transcriptBytes: number | undefined;
  inboxMissing: boolean;
  taskStatus: string | undefined;
  taskFailure: unknown;
  pageEventTypes: readonly string[];
  markerPresent: boolean;
  recoveryStatusPresent: boolean;
  browserApplicationErrorCount: number;
  pageErrorCount: number;
  failedRequestCount: number;
  child: {
    alive: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdoutBytes: number;
    stderrBytes: number;
  };
}): string {
  const pendingResume = input.sseEvents.flatMap((event) => {
    if (event.type !== 'pending.resume') return [];
    const phase = event.properties.phase;
    if (
      phase !== 'retry_scheduled' &&
      phase !== 'recovered' &&
      phase !== 'failed' &&
      phase !== 'exhausted'
    ) {
      return [];
    }
    return [
      {
        phase,
        attempt: Number.isSafeInteger(event.properties.attempt)
          ? event.properties.attempt
          : null,
        maxAttempts: Number.isSafeInteger(event.properties.maxAttempts)
          ? event.properties.maxAttempts
          : null,
      },
    ];
  });
  const writeCalls = input.durableEvents.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_call' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolName === 'Write'
  ).length;
  const writeResults = input.durableEvents.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolName === 'Write'
  ).length;
  const taskFailure = isSessionTaskFailure(input.taskFailure)
    ? {
        code: input.taskFailure.code,
        retryable: input.taskFailure.retryable,
        ...(input.taskFailure.resource ? { resource: input.taskFailure.resource } : {}),
      }
    : null;
  const diagnostic = JSON.stringify({
    outcome: input.outcome,
    elapsedMs: Math.max(0, Math.floor(input.elapsedMs)),
    sseEventCounts: countSafeEventTypes(input.sseEvents.map((event) => event.type)),
    pendingResume,
    durableEventCounts: Object.fromEntries(
      [...RECOVERY_DIAGNOSTIC_EVENT_TYPES].flatMap((type) => {
        const count = input.durableEvents.filter((event) => event.type === type).length;
        return count > 0 ? [[type, count]] : [];
      })
    ),
    writeCalls,
    writeResults,
    durableMarkerPresent:
      finalAssistantText(input.durableEvents)?.includes(input.expectedMarker) ?? false,
    proxyLifecycle: input.proxyLifecycle.slice(-32).map((entry) => ({
      requestNumber: entry.requestNumber,
      phase: entry.phase,
      ...(entry.statusClass === undefined ? {} : { statusClass: entry.statusClass }),
    })),
    targetBytes: boundedByteSize(input.targetBytes),
    transcriptBytes: boundedByteSize(input.transcriptBytes),
    inboxMissing: input.inboxMissing,
    taskStatus: [
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ].includes(input.taskStatus ?? '')
      ? input.taskStatus
      : null,
    taskFailure,
    pageEventCounts: countSafeEventTypes(input.pageEventTypes),
    markerPresent: input.markerPresent,
    recoveryStatusPresent: input.recoveryStatusPresent,
    browserFaults: {
      console: Math.max(0, input.browserApplicationErrorCount),
      page: Math.max(0, input.pageErrorCount),
      request: Math.max(0, input.failedRequestCount),
    },
    child: {
      alive: input.child.alive,
      exitCode: input.child.exitCode,
      signalCode: input.child.signalCode,
      stdoutBytes: boundedByteSize(input.child.stdoutBytes),
      stderrBytes: boundedByteSize(input.child.stderrBytes),
    },
  });
  return Buffer.byteLength(diagnostic) <= 4_096
    ? diagnostic
    : JSON.stringify({ outcome: input.outcome, diagnostic: 'overflow' });
}

async function buildProductionWebRecoveryDiagnosticBounded(input: {
  outcome: 'timeout' | 'terminal_failure';
  startedAt: number;
  page: Page | undefined;
  probe: ProductionEventProbe | undefined;
  proxy: RecordingProviderProxy;
  store: PersistentStore;
  sessionId: string;
  projectPath: string;
  target: string;
  finalMarker: string;
  child: ChildProcess | undefined;
  stdout: readonly string[];
  stderr: readonly string[];
  browserApplicationErrorCount: number;
  pageErrorCount: number;
  failedRequestCount: number;
}): Promise<string> {
  const collect = async (): Promise<string> => {
    const [
      durableEvents,
      targetBytes,
      transcriptBytes,
      inboxMissing,
      metadata,
      pageEventTypes,
      markerPresent,
      recoveryStatusPresent,
    ] = await Promise.all([
      input.store.loadEvents(input.sessionId).catch(() => []),
      optionalFileSize(input.target).catch(() => undefined),
      optionalFileSize(getSessionFilePath(input.projectPath, input.sessionId)).catch(
        () => undefined
      ),
      fileIsMissing(getSessionInboxFilePath(input.projectPath, input.sessionId)).catch(
        () => false
      ),
      SessionService.findSessionMetadata(input.sessionId, input.projectPath).catch(
        () => undefined
      ),
      input.page
        ?.evaluate(
          () =>
            (
              window as typeof window & {
                __bladeQualificationEventTypes?: string[];
              }
            ).__bladeQualificationEventTypes ?? []
        )
        .catch(() => []) ?? Promise.resolve([] as string[]),
      input.page
        ?.getByText(input.finalMarker, { exact: true })
        .isVisible()
        .catch(() => false) ?? Promise.resolve(false),
      input.page
        ?.getByText('Recovery attempt', { exact: false })
        .isVisible()
        .catch(() => false) ?? Promise.resolve(false),
    ]);
    return formatProductionWebRecoveryDiagnostic({
      outcome: input.outcome,
      elapsedMs: Date.now() - input.startedAt,
      sseEvents: input.probe?.events ?? [],
      durableEvents: durableEvents ?? [],
      expectedMarker: input.finalMarker,
      proxyLifecycle: input.proxy.requestLifecycle,
      targetBytes,
      transcriptBytes,
      inboxMissing,
      taskStatus: metadata?.taskStatus,
      taskFailure: metadata?.taskFailure,
      pageEventTypes,
      markerPresent,
      recoveryStatusPresent,
      browserApplicationErrorCount: input.browserApplicationErrorCount,
      pageErrorCount: input.pageErrorCount,
      failedRequestCount: input.failedRequestCount,
      child: {
        alive:
          input.child !== undefined &&
          input.child.exitCode === null &&
          input.child.signalCode === null,
        exitCode: input.child?.exitCode ?? null,
        signalCode: input.child?.signalCode ?? null,
        stdoutBytes: Buffer.byteLength(input.stdout.join('')),
        stderrBytes: Buffer.byteLength(input.stderr.join('')),
      },
    });
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collect().catch(() => 'diagnostic unavailable'),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('diagnostic unavailable'), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForProductionWebFinalMarker(
  page: Page,
  events: readonly ProductionWebRecoveryEvidence['sseEvents'][number][],
  finalMarker: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let completedAt: number | undefined;
  while (Date.now() < deadline) {
    if (
      await page
        .getByText(finalMarker, { exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }
    const failure = findProductionWebTerminalFailure(events);
    if (failure) {
      throw new Error(
        failure.type === 'session.error'
          ? 'Production Web recovery emitted session.error'
          : `Production Web recovery emitted pending.resume ${failure.phase}`
      );
    }
    if (events.some((event) => event.type === 'session.completed')) {
      completedAt ??= Date.now();
      if (Date.now() - completedAt >= 5_000) {
        throw new Error('Production Web completed without rendering the final marker');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the production Web final marker');
}

async function waitForProductionCondition(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
}

export async function reserveProductionWebPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve production Web qualification port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function openProductionEventProbe(
  origin: string,
  sessionId: string,
  projectPath: string
): Promise<ProductionEventProbe> {
  const controller = new AbortController();
  const url = new URL(`${origin}/sessions/${sessionId}/events`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`Production Web SSE failed: ${response.status}`);
  }
  const events: ProductionEventProbe['events'] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readError: unknown;
  const consume = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as { type?: unknown; properties?: unknown };
    if (typeof event.type === 'string' && isRecord(event.properties)) {
      events.push({ type: event.type, properties: event.properties });
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
      if (!controller.signal.aborted) readError = error;
    }
  })();
  await waitForProductionCondition(
    () => events.some((event) => event.type === 'connected'),
    'Production Web SSE did not connect',
    20_000
  );
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading;
      if (readError) throw readError;
    },
  };
}

export function waitForProductionChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Production Web qualification server did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export function validateProductionWebRecoveryEvidence(
  evidence: ProductionWebRecoveryEvidence
): { writeSha256: string; attempts: number[]; phases: string[] } {
  const writes = evidence.durableEvents.flatMap((event) => {
    if (event.type !== 'part_created' || event.data.partType !== 'tool_call') return [];
    const payload = event.data.payload;
    if (!isRecord(payload) || payload.toolName !== 'Write') return [];
    return [payload];
  });
  if (writes.length !== 1) throw new Error('Expected exactly one Write tool call');
  const write = writes[0]!;
  if (typeof write.toolCallId !== 'string' || !isRecord(write.input)) {
    throw new Error('Write tool call evidence is malformed');
  }
  if (
    write.input.file_path !== evidence.targetPath ||
    write.input.content !== 'Canary\n' ||
    evidence.targetContent !== 'Canary\n'
  ) {
    throw new Error('Write content did not match the exact Canary contract');
  }
  const matchingResults = evidence.durableEvents.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolName === 'Write' &&
      event.data.payload.toolCallId === write.toolCallId &&
      event.data.payload.error === null &&
      event.data.payload.output !== null
  );
  if (matchingResults.length !== 1) {
    throw new Error('Expected exactly one successful matching Write result');
  }
  for (const type of [
    'interaction_requested',
    'interaction_responded',
    'interaction_recovered',
  ] as const) {
    if (evidence.durableEvents.filter((event) => event.type === type).length !== 1) {
      throw new Error(`Expected exactly one ${type} event`);
    }
  }
  const assistantMessageIds = new Set(
    evidence.durableEvents.flatMap((event) =>
      event.type === 'message_created' && event.data.role === 'assistant'
        ? [event.data.messageId]
        : []
    )
  );
  const assistantText = evidence.durableEvents
    .flatMap((event) => {
      if (
        event.type !== 'part_created' ||
        event.data.partType !== 'text' ||
        !assistantMessageIds.has(event.data.messageId) ||
        !isRecord(event.data.payload) ||
        typeof event.data.payload.text !== 'string'
      ) {
        return [];
      }
      return [event.data.payload.text];
    })
    .join('');
  if (assistantText.split(evidence.finalMarker).length - 1 !== 1) {
    throw new Error('Expected exactly one durable final marker');
  }
  const completionCount = evidence.sseEvents.filter(
    (event) => event.type === 'session.completed'
  ).length;
  if (completionCount !== 1) throw new Error('Expected exactly one session.completed');
  if (
    evidence.sseEvents.some(
      (event) =>
        event.type === 'session.error' ||
        (event.type === 'pending.resume' &&
          ['failed', 'exhausted'].includes(String(event.properties.phase)))
    )
  ) {
    throw new Error('Production Web recovery reached an unexpected terminal failure');
  }
  if (!evidence.sseEvents.some((event) => event.type === 'provider.retry')) {
    throw new Error('Expected the first outer attempt to emit provider.retry');
  }
  const pendingResume = evidence.sseEvents.filter(
    (event) => event.type === 'pending.resume'
  );
  const phases = pendingResume.map((event) => String(event.properties.phase));
  const attempts = pendingResume.map((event) => Number(event.properties.attempt));
  if (
    phases.length !== 2 ||
    phases[0] !== 'retry_scheduled' ||
    phases[1] !== 'recovered' ||
    attempts[0] !== 2 ||
    attempts[1] !== 2 ||
    pendingResume.some(
      (event) =>
        event.properties.kind !== 'pending_input' || event.properties.maxAttempts !== 4
    )
  ) {
    throw new Error('Pending resume phases or attempt semantics are invalid');
  }
  const delayMs = Number(pendingResume[0]?.properties.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 4_800) {
    throw new Error('Pending resume delay is outside its bounded policy');
  }
  return {
    attempts,
    phases,
    writeSha256: createHash('sha256').update(evidence.targetContent).digest('hex'),
  };
}

export function buildDurableInteractionRecoveryConfig(
  base: RuntimeConfig
): RuntimeConfig {
  const providerWorstCaseMs =
    DURABLE_INTERACTION_PROVIDER_BOUNDARIES.length *
    (DURABLE_INTERACTION_PROVIDER_ADMISSION_MS +
      DURABLE_INTERACTION_PROVIDER_ATTEMPT_MS +
      DURABLE_INTERACTION_PROVIDER_RECOVERY_MS);
  if (
    providerWorstCaseMs >
    DURABLE_INTERACTION_STRICT_WAIT_MS - DURABLE_INTERACTION_FINALIZATION_RESERVE_MS
  ) {
    throw new Error('Durable interaction recovery budget exceeds its surface deadline');
  }
  return {
    ...base,
    providerForegroundRecoveryMs: DURABLE_INTERACTION_PROVIDER_RECOVERY_MS,
    providerRequestAdmissionMs: DURABLE_INTERACTION_PROVIDER_ADMISSION_MS,
    models: base.models.map((model) => ({
      ...model,
      overrides: {
        ...model.overrides,
        timeout: DURABLE_INTERACTION_PROVIDER_ATTEMPT_MS,
        streamIdleTimeout: DURABLE_INTERACTION_PROVIDER_ATTEMPT_MS,
      },
    })),
  };
}

function boundedByteSize(
  bytes: number | undefined
): 0 | '1_4096' | '4097_16384' | '16385_plus' {
  if (!bytes) return 0;
  if (bytes <= 4_096) return '1_4096';
  if (bytes <= 16_384) return '4097_16384';
  return '16385_plus';
}

function textDiagnostic(
  text: string | undefined,
  expectedText: string
): {
  present: boolean;
  utf8ByteSizeBucket: ReturnType<typeof boundedByteSize>;
  sha256Prefix: string | null;
  expectedMarkerPresent: boolean;
} {
  const present = Boolean(text?.trim());
  return {
    present,
    utf8ByteSizeBucket: boundedByteSize(
      present && text ? Buffer.byteLength(text, 'utf8') : undefined
    ),
    sha256Prefix:
      present && text
        ? createHash('sha256').update(text).digest('hex').slice(0, 12)
        : null,
    expectedMarkerPresent: present && text ? text.includes(expectedText) : false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatAcpRecoveryDiagnostic(input: {
  events: readonly SessionEvent[];
  acpText: string;
  expectedText: string;
  inboxMissing: boolean;
  permissionRequests: number;
  targetPresent: boolean;
}): string {
  const observedEventCounts: Record<string, number> = {};
  const writeCallIds = new Set<string>();
  const writeResults = new Map<string, boolean>();
  for (const event of input.events) {
    if (ACP_RECOVERY_DIAGNOSTIC_EVENT_TYPES.has(event.type)) {
      observedEventCounts[event.type] = (observedEventCounts[event.type] ?? 0) + 1;
    }
    if (event.type !== 'part_created' || !isRecord(event.data.payload)) continue;
    const { partType, payload } = event.data;
    if (payload.toolName !== 'Write') continue;
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId !== 'string' || !toolCallId) continue;
    if (partType === 'tool_call') {
      writeCallIds.add(toolCallId);
    } else if (partType === 'tool_result') {
      writeResults.set(toolCallId, payload.error === null && payload.output !== null);
    }
  }
  const durableFinal = finalAssistantText(input.events);
  const eventCounts = Object.fromEntries(
    [...ACP_RECOVERY_DIAGNOSTIC_EVENT_TYPES].flatMap((type) =>
      observedEventCounts[type] === undefined ? [] : [[type, observedEventCounts[type]]]
    )
  );

  return JSON.stringify({
    eventCounts,
    turns: {
      completed: eventCounts.turn_completed ?? 0,
      aborted: eventCounts.turn_aborted ?? 0,
    },
    write: {
      calls: writeCallIds.size,
      results: writeResults.size,
      succeeded:
        writeCallIds.size > 0 &&
        writeCallIds.size === writeResults.size &&
        [...writeCallIds].every((toolCallId) => writeResults.get(toolCallId) === true),
    },
    durableFinal: textDiagnostic(durableFinal, input.expectedText),
    acpEgress: textDiagnostic(input.acpText, input.expectedText),
    inboxMissing: input.inboxMissing,
    permissionRequests: input.permissionRequests,
    targetPresent: input.targetPresent,
  });
}

async function optionalFileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function buildWebRecoveryDiagnostic(
  input: WebRecoveryWaitInput,
  observedEvents: readonly BusEvent[],
  outcome: { kind: 'timeout'; timeoutMs: number } | { kind: 'failure' }
): Promise<string> {
  const store = new PersistentStore(input.projectPath);
  const [targetBytes, transcriptBytes, inboxMissing, metadata, durableEvents] =
    await Promise.all([
      optionalFileSize(input.target),
      optionalFileSize(getSessionFilePath(input.projectPath, input.sessionId)),
      fileIsMissing(getSessionInboxFilePath(input.projectPath, input.sessionId)),
      SessionService.findSessionMetadata(input.sessionId, input.projectPath),
      store.loadEvents(input.sessionId),
    ]);
  const busEventCounts: Record<string, number> = {};
  for (const type of observedEvents.map((event) => event.type)) {
    if (!RECOVERY_DIAGNOSTIC_EVENT_TYPES.has(type)) continue;
    busEventCounts[type] = (busEventCounts[type] ?? 0) + 1;
  }
  const durableEventCounts: Record<string, number> = {};
  for (const type of (durableEvents ?? []).map((event) => event.type)) {
    if (!RECOVERY_DIAGNOSTIC_EVENT_TYPES.has(type)) continue;
    durableEventCounts[type] = (durableEventCounts[type] ?? 0) + 1;
  }
  const terminalFailure = observedEvents
    .filter((event) => event.type === 'session.error')
    .map((event) => event.properties.taskFailure)
    .findLast(isSessionTaskFailure);
  const taskFailure = metadata?.taskFailure ?? terminalFailure;

  return JSON.stringify({
    outcome: outcome.kind,
    ...(outcome.kind === 'timeout' ? { timeoutMs: outcome.timeoutMs } : {}),
    taskFailure: taskFailure
      ? {
          code: taskFailure.code,
          retryable: taskFailure.retryable,
          ...(taskFailure.resource ? { resource: taskFailure.resource } : {}),
        }
      : null,
    taskStatus: metadata?.taskStatus ?? null,
    selectedModelDigest: metadata?.selectedModelId
      ? createHash('sha256').update(metadata.selectedModelId).digest('hex').slice(0, 12)
      : null,
    pendingInteractionType: metadata?.pendingInteraction?.type ?? null,
    busEventCounts,
    durableEventCounts,
    targetBytes: boundedByteSize(targetBytes),
    transcriptBytes: boundedByteSize(transcriptBytes),
    inboxMissing,
    runtimeResidency: input.controller.getRuntimeResidencyStats(),
  });
}

export async function buildWebRecoveryDiagnosticBounded(
  input: WebRecoveryWaitInput,
  observedEvents: readonly BusEvent[],
  outcome: { kind: 'timeout'; timeoutMs: number } | { kind: 'failure' },
  timeoutMs = WEB_RECOVERY_DIAGNOSTIC_TIMEOUT_MS
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      buildWebRecoveryDiagnostic(input, observedEvents, outcome).catch(
        () => 'diagnostic unavailable'
      ),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('diagnostic unavailable'), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function waitForWebRecovery(input: WebRecoveryWaitInput): {
  promise: Promise<void>;
  cancel(): void;
} {
  const configuredTimeout = Number(process.env.BLADE_DURABLE_WEB_RECOVERY_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DURABLE_INTERACTION_WEB_WAIT_MS;
  const observedEvents: BusEvent[] = [];
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      void buildWebRecoveryDiagnosticBounded(input, observedEvents, {
        kind: 'timeout',
        timeoutMs,
      }).then((diagnostic) => {
        reject(
          new Error(
            `Timed out waiting for durable Web interaction recovery: ${diagnostic}`
          )
        );
      });
    }, timeoutMs);
    unsubscribe = Bus.subscribe((event) => {
      if (
        event.sessionId !== input.sessionId ||
        event.projectPath !== input.projectPath
      ) {
        return;
      }
      observedEvents.push(event);
      if (event.type === 'permission.asked' || event.type === 'question.required') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error('Recovered interaction unexpectedly requested input again'));
      } else if (event.type === 'session.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (event.type === 'session.error') {
        clearTimeout(timeout);
        unsubscribe();
        void buildWebRecoveryDiagnosticBounded(input, observedEvents, {
          kind: 'failure',
        }).then((diagnostic) => {
          reject(
            new Error('Recovered Web interaction failed; diagnostic=' + diagnostic)
          );
        });
      }
    });
  });
  return {
    promise,
    cancel() {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    },
  };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function fileIsMissing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function buildAcpRecoveryTimeoutDiagnostic(input: {
  client: MockACPClient;
  target: string;
  workspace: string;
  sessionId: string;
  expectedText: string;
}): Promise<string> {
  const store = new PersistentStore(input.workspace);
  const [events, hostTargetBytes, inboxMissing] = await Promise.all([
    store.loadEvents(input.sessionId),
    optionalFileSize(input.target),
    fileIsMissing(getSessionInboxFilePath(input.workspace, input.sessionId)),
  ]);
  const acpText = input.client.sessionUpdates
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
  return formatAcpRecoveryDiagnostic({
    events: events ?? [],
    acpText,
    expectedText: input.expectedText,
    inboxMissing,
    permissionRequests: input.client.permissionRequests.length,
    targetPresent:
      hostTargetBytes !== undefined || input.client.files.has(input.target),
  });
}

export async function buildAcpRecoveryTimeoutDiagnosticBounded(
  input: {
    client: MockACPClient;
    target: string;
    workspace: string;
    sessionId: string;
    expectedText: string;
  },
  timeoutMs = ACP_RECOVERY_DIAGNOSTIC_TIMEOUT_MS
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      buildAcpRecoveryTimeoutDiagnostic(input).catch(() => 'diagnostic unavailable'),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('diagnostic unavailable'), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForAcpRecovery(input: {
  client: MockACPClient;
  target: string;
  workspace: string;
  sessionId: string;
  expectedContent: string;
  expectedText: string;
}): Promise<string> {
  const configuredTimeout = Number(process.env.BLADE_DURABLE_ACP_RECOVERY_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DURABLE_INTERACTION_ACP_WAIT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hostContent = await readOptionalFile(input.target);
    const clientContent = [...input.client.files.values()].find(
      (content) => content === input.expectedContent
    );
    const agentText = input.client.sessionUpdates
      .flatMap((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
          ? [notification.update.content.text]
          : []
      )
      .join('');
    if (
      (hostContent ?? clientContent) === input.expectedContent &&
      agentText.includes(input.expectedText) &&
      (await fileIsMissing(getSessionInboxFilePath(input.workspace, input.sessionId)))
    ) {
      return hostContent ?? clientContent ?? '';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await buildAcpRecoveryTimeoutDiagnosticBounded({
    client: input.client,
    target: input.target,
    workspace: input.workspace,
    sessionId: input.sessionId,
    expectedText: input.expectedText,
  });
  throw new Error(
    `Timed out waiting for durable ACP interaction completion: ${diagnostic}`
  );
}

describe('durable ACP recovery diagnostics', () => {
  it('keeps Provider recovery inside the surface deadline', () => {
    const base = buildRealApiRuntimeConfig({
      id: 'gpt',
      qualificationId: 'gpt:budget-contract',
      name: 'GPT budget contract',
      provider: 'openai-compatible',
      model: 'gpt-budget-contract',
      apiKey: 'budget-contract-key',
      baseURL: 'https://gateway.invalid/v1',
    });
    const config = buildDurableInteractionRecoveryConfig(base);

    expect(config.providerForegroundRecoveryMs).toBe(30_000);
    expect(config.providerRequestAdmissionMs).toBe(5_000);
    expect(config.models).toHaveLength(1);
    expect(config.models[0]?.overrides).toMatchObject({
      timeout: 35_000,
      streamIdleTimeout: 35_000,
    });
    const threeProviderBoundariesMs = 3 * (5_000 + 35_000 + 30_000);
    expect(DURABLE_INTERACTION_PROVIDER_BOUNDARIES).toEqual([
      'recovered_tool_call',
      'post_tool_final',
      'optional_empty_final_correction',
    ]);
    expect(threeProviderBoundariesMs).toBeLessThanOrEqual(
      DURABLE_INTERACTION_STRICT_WAIT_MS - DURABLE_INTERACTION_FINALIZATION_RESERVE_MS
    );
    expect(DURABLE_INTERACTION_ACP_WAIT_MS).toBeGreaterThanOrEqual(
      DURABLE_INTERACTION_WEB_WAIT_MS
    );
  });

  it('summarizes a completed Write without exposing durable or ACP text', () => {
    const createdAt = '2026-08-20T00:00:00.000Z';
    const sessionId = 'acp-recovery-diagnostic-session';
    const turnId = 'acp-recovery-diagnostic-turn';
    const toolCallId = 'acp-recovery-write-call';
    const secret = 'acp-recovery-provider-secret';
    const target = `/private/workspace/${secret}/selected-channel.txt`;
    const expectedText = `ACP_INTERACTION_RECOVERED_${secret}`;
    const rawToolOutput = `Wrote ${target} using ${secret}`;
    const events: SessionEvent[] = [
      {
        id: 'session-created',
        sessionId,
        timestamp: createdAt,
        type: 'session_created',
        cwd: target,
        version: 'test',
        data: {
          sessionId,
          rootId: sessionId,
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        id: 'interaction-requested',
        sessionId,
        timestamp: createdAt,
        type: 'interaction_requested',
        cwd: target,
        version: 'test',
        data: {
          requestId: 'request-1',
          toolCallId: 'question-call',
          toolName: 'AskUserQuestion',
          interactionType: 'question',
          details: { prompt: secret, target },
          requestedAt: createdAt,
        },
      },
      {
        id: 'interaction-responded',
        sessionId,
        timestamp: createdAt,
        type: 'interaction_responded',
        cwd: target,
        version: 'test',
        data: {
          requestId: 'request-1',
          response: { selected: secret },
          respondedAt: createdAt,
        },
      },
      {
        id: 'interaction-recovered',
        sessionId,
        timestamp: createdAt,
        type: 'interaction_recovered',
        cwd: target,
        version: 'test',
        data: {
          requestId: 'request-1',
          inboxMessageId: 'inbox-message-1',
          recoveredAt: createdAt,
        },
      },
      {
        id: 'turn-started',
        sessionId,
        timestamp: createdAt,
        type: 'turn_started',
        cwd: target,
        version: 'test',
        data: {
          turnId,
          kind: 'pending',
          startedAt: createdAt,
          inputMessageIds: ['inbox-message-1'],
        },
      },
      {
        id: 'write-message-created',
        sessionId,
        timestamp: createdAt,
        type: 'message_created',
        cwd: target,
        version: 'test',
        data: {
          messageId: 'write-message',
          role: 'assistant',
          createdAt,
        },
      },
      {
        id: 'write-call-created',
        sessionId,
        timestamp: createdAt,
        type: 'part_created',
        cwd: target,
        version: 'test',
        data: {
          partId: 'write-call-part',
          messageId: 'write-message',
          partType: 'tool_call',
          payload: {
            toolCallId,
            toolName: 'Write',
            input: { file_path: target, content: secret },
          },
          createdAt,
        },
      },
      {
        id: 'write-result-created',
        sessionId,
        timestamp: createdAt,
        type: 'part_created',
        cwd: target,
        version: 'test',
        data: {
          partId: 'write-result-part',
          messageId: 'write-message',
          partType: 'tool_result',
          payload: {
            toolCallId,
            toolName: 'Write',
            output: rawToolOutput,
            error: null,
          },
          createdAt,
        },
      },
      {
        id: 'inbox-acknowledged',
        sessionId,
        timestamp: createdAt,
        type: 'inbox_acknowledged',
        cwd: target,
        version: 'test',
        data: {
          messageIds: ['inbox-message-1'],
          acknowledgedAt: createdAt,
        },
      },
      {
        id: 'turn-completed',
        sessionId,
        timestamp: createdAt,
        type: 'turn_completed',
        cwd: target,
        version: 'test',
        data: {
          turnId,
          completedAt: createdAt,
          turnsCount: 2,
          toolCallsCount: 1,
          durationMs: 1,
        },
      },
      {
        id: 'session-updated',
        sessionId,
        timestamp: createdAt,
        type: 'session_updated',
        cwd: target,
        version: 'test',
        data: {
          sessionId,
          rootId: sessionId,
          taskStatus: 'completed',
          createdAt,
          updatedAt: createdAt,
        },
      },
    ];

    const diagnostic = formatAcpRecoveryDiagnostic({
      events,
      acpText: '',
      expectedText,
      inboxMissing: true,
      permissionRequests: 1,
      targetPresent: true,
    });

    expect(diagnostic).toContain(
      '"eventCounts":{"session_created":1,"session_updated":1,' +
        '"turn_started":1,"interaction_requested":1,' +
        '"interaction_responded":1,"interaction_recovered":1,' +
        '"inbox_acknowledged":1,"turn_completed":1,' +
        '"message_created":1,"part_created":2}'
    );
    expect(diagnostic).toContain('"turns":{"completed":1,"aborted":0}');
    expect(diagnostic).toContain('"write":{"calls":1,"results":1,"succeeded":true}');
    expect(diagnostic).toContain(
      '"durableFinal":{"present":false,"utf8ByteSizeBucket":0,' +
        '"sha256Prefix":null,"expectedMarkerPresent":false}'
    );
    expect(diagnostic).toContain(
      '"acpEgress":{"present":false,"utf8ByteSizeBucket":0,' +
        '"sha256Prefix":null,"expectedMarkerPresent":false}'
    );
    expect(diagnostic).toContain(
      '"inboxMissing":true,"permissionRequests":1,"targetPresent":true'
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(target);
    expect(diagnostic).not.toContain(rawToolOutput);
    expect(diagnostic).not.toContain(expectedText);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(4_096);
  });

  it('uses a fixed fallback when timeout evidence collection fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-diagnostic-fail-'));
    const secret = 'acp-diagnostic-io-secret';
    const workspace = path.join(root, `workspace-${secret}`);
    const sessionId = `session-${secret}`;
    const target = path.join(workspace, `target-${secret}.txt`);
    const client = createMockACPClient();

    try {
      await writeFile(workspace, secret, { mode: 0o600 });
      const diagnostic = await buildAcpRecoveryTimeoutDiagnosticBounded({
        client,
        target,
        workspace,
        sessionId,
        expectedText: `EXPECTED_${secret}`,
      });

      expect(diagnostic).toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(workspace);
      expect(diagnostic).not.toContain(target);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the safe diagnostic when evidence settles quickly', async () => {
    const secret = 'acp-diagnostic-fast-secret';
    const workspace = `/private/workspace-${secret}`;
    const sessionId = `session-${secret}`;
    const target = `${workspace}/target-${secret}.txt`;
    const client = createMockACPClient();
    const loadEventsSpy = vi
      .spyOn(PersistentStore.prototype, 'loadEvents')
      .mockResolvedValue([]);
    const input = {
      client,
      target,
      workspace,
      sessionId,
      expectedText: `EXPECTED_${secret}`,
    };

    try {
      const expected = await buildAcpRecoveryTimeoutDiagnostic(input);
      const diagnostic = await buildAcpRecoveryTimeoutDiagnosticBounded(input, 200);

      expect(diagnostic).toBe(expected);
      expect(diagnostic).toContain('"eventCounts":{}');
      expect(diagnostic).toContain('"inboxMissing":true');
      expect(diagnostic).not.toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(workspace);
      expect(diagnostic).not.toContain(target);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      loadEventsSpy.mockRestore();
    }
  });

  it('returns a fixed fallback when durable event evidence never settles', async () => {
    const secret = 'acp-diagnostic-deadline-secret';
    const workspace = `/private/workspace-${secret}`;
    const sessionId = `session-${secret}`;
    const target = `${workspace}/target-${secret}.txt`;
    const client = createMockACPClient();
    const loadEventsSpy = vi
      .spyOn(PersistentStore.prototype, 'loadEvents')
      .mockImplementation(() => new Promise<never>(() => undefined));

    try {
      const startedAt = performance.now();
      const diagnostic = await buildAcpRecoveryTimeoutDiagnosticBounded(
        {
          client,
          target,
          workspace,
          sessionId,
          expectedText: `EXPECTED_${secret}`,
        },
        20
      );

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(diagnostic).toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(workspace);
      expect(diagnostic).not.toContain(target);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      loadEventsSpy.mockRestore();
    }
  }, 1_000);

  it('returns a fixed fallback when evidence collection rejects quickly', async () => {
    const secret = 'acp-diagnostic-rejection-secret';
    const workspace = `/private/workspace-${secret}`;
    const sessionId = `session-${secret}`;
    const target = `${workspace}/target-${secret}.txt`;
    const client = createMockACPClient();
    const loadEventsSpy = vi
      .spyOn(PersistentStore.prototype, 'loadEvents')
      .mockRejectedValue(new Error(`failed at ${workspace}/${sessionId}/${secret}`));

    try {
      const diagnostic = await buildAcpRecoveryTimeoutDiagnosticBounded(
        {
          client,
          target,
          workspace,
          sessionId,
          expectedText: `EXPECTED_${secret}`,
        },
        200
      );

      expect(diagnostic).toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(workspace);
      expect(diagnostic).not.toContain(target);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      loadEventsSpy.mockRestore();
    }
  });

  it('does not treat a mismatched Write result as a successful pair', () => {
    const createdAt = '2026-08-20T00:00:00.000Z';
    const events: SessionEvent[] = [
      {
        id: 'write-call-mismatch',
        sessionId: 'write-pair-session',
        timestamp: createdAt,
        type: 'part_created',
        cwd: '/private/write-pair',
        version: 'test',
        data: {
          partId: 'write-call-part',
          messageId: 'write-message',
          partType: 'tool_call',
          payload: {
            toolCallId: 'write-call-a',
            toolName: 'Write',
            input: { file_path: '/private/write-pair/a.txt', content: 'a' },
          },
          createdAt,
        },
      },
      {
        id: 'write-result-mismatch',
        sessionId: 'write-pair-session',
        timestamp: createdAt,
        type: 'part_created',
        cwd: '/private/write-pair',
        version: 'test',
        data: {
          partId: 'write-result-part',
          messageId: 'write-message',
          partType: 'tool_result',
          payload: {
            toolCallId: 'write-call-b',
            toolName: 'Write',
            output: 'written',
            error: null,
          },
          createdAt,
        },
      },
    ];

    expect(
      formatAcpRecoveryDiagnostic({
        events,
        acpText: '',
        expectedText: 'EXPECTED',
        inboxMissing: false,
        permissionRequests: 0,
        targetPresent: false,
      })
    ).toContain('"write":{"calls":1,"results":1,"succeeded":false}');
  });
});

describe('durable Web recovery diagnostics', () => {
  it('formats bounded structural production diagnostics without retaining secrets', () => {
    const secret = 'production-web-diagnostic-secret';
    const createdAt = '2026-08-29T00:00:00.000Z';
    const diagnostic = formatProductionWebRecoveryDiagnostic({
      outcome: 'terminal_failure',
      elapsedMs: 123_456,
      sseEvents: [
        {
          type: 'pending.resume',
          properties: {
            phase: 'retry_scheduled',
            attempt: 2,
            maxAttempts: 4,
            unsafe: secret,
          },
        },
        {
          type: 'session.error',
          properties: { error: secret },
        },
      ],
      durableEvents: [
        {
          id: 'write-call',
          sessionId: secret,
          timestamp: createdAt,
          type: 'part_created',
          cwd: `/private/${secret}`,
          version: 'test',
          data: {
            messageId: 'assistant',
            partId: 'write-call',
            partType: 'tool_call',
            createdAt,
            payload: {
              toolCallId: 'write-call',
              toolName: 'Write',
              input: { file_path: `/private/${secret}`, content: secret },
            },
          },
        },
      ],
      expectedMarker: `GUI_RECOVERED_${secret}`,
      proxyLifecycle: [
        { requestNumber: 2, phase: 'release_observed' },
        { requestNumber: 2, phase: 'headers_received', statusClass: 2 },
      ],
      targetBytes: 7,
      transcriptBytes: 8_000,
      inboxMissing: false,
      taskStatus: 'failed',
      taskFailure: {
        code: 'timeout',
        message: 'Provider request timed out.',
        retryable: true,
      },
      pageEventTypes: ['question.required', secret],
      markerPresent: false,
      recoveryStatusPresent: false,
      browserApplicationErrorCount: 1,
      pageErrorCount: 2,
      failedRequestCount: 3,
      child: {
        alive: true,
        exitCode: null,
        signalCode: null,
        stdoutBytes: 65,
        stderrBytes: 4_500,
      },
    });

    expect(diagnostic).toContain('"outcome":"terminal_failure"');
    expect(diagnostic).toContain('"phase":"headers_received"');
    expect(diagnostic).toContain('"pendingResume"');
    expect(diagnostic).toContain('"writeCalls":1');
    expect(diagnostic).toContain('"taskFailure":{"code":"timeout"');
    expect(diagnostic).toContain('"pageEventCounts":{"question.required":1}');
    expect(diagnostic).not.toContain(secret);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(4_096);
  });

  it('detects authoritative production recovery failures before a marker timeout', () => {
    expect(
      findProductionWebTerminalFailure([
        {
          type: 'pending.resume',
          properties: { phase: 'retry_scheduled', attempt: 2 },
        },
        {
          type: 'pending.resume',
          properties: { phase: 'exhausted', attempt: 2 },
        },
      ])
    ).toEqual({ type: 'pending.resume', phase: 'exhausted' });
    expect(
      findProductionWebTerminalFailure([{ type: 'session.completed', properties: {} }])
    ).toBeNull();
  });

  it('validates the exact production Chromium pending-resume trajectory', () => {
    const createdAt = '2026-08-29T00:00:00.000Z';
    const writeInput = { file_path: '/tmp/canary.txt', content: 'Canary\n' };
    const durableEvents = [
      ['interaction_requested', {}],
      ['interaction_responded', {}],
      ['interaction_recovered', {}],
      [
        'part_created',
        {
          partType: 'tool_call',
          payload: { toolCallId: 'write-1', toolName: 'Write', input: writeInput },
        },
      ],
      [
        'part_created',
        {
          partType: 'tool_result',
          payload: {
            toolCallId: 'write-1',
            toolName: 'Write',
            output: 'ok',
            error: null,
          },
        },
      ],
      ['message_created', { messageId: 'final', role: 'assistant' }],
      [
        'part_created',
        {
          partId: 'final-text',
          messageId: 'final',
          partType: 'text',
          payload: { text: 'GUI_RECOVERED' },
        },
      ],
      ['session.completed', {}],
    ].map(([type, data], index) => ({
      id: `event-${index}`,
      sessionId: 'session',
      timestamp: createdAt,
      type,
      cwd: '/tmp',
      version: 'test',
      data,
    })) as SessionEvent[];

    expect(
      validateProductionWebRecoveryEvidence({
        sseEvents: [
          { type: 'provider.retry', properties: { phase: 'scheduled' } },
          {
            type: 'pending.resume',
            properties: {
              phase: 'retry_scheduled',
              attempt: 2,
              maxAttempts: 4,
              kind: 'pending_input',
              delayMs: 900,
            },
          },
          {
            type: 'pending.resume',
            properties: {
              phase: 'recovered',
              attempt: 2,
              maxAttempts: 4,
              kind: 'pending_input',
            },
          },
          { type: 'session.completed', properties: {} },
        ],
        durableEvents,
        targetContent: 'Canary\n',
        targetPath: '/tmp/canary.txt',
        finalMarker: 'GUI_RECOVERED',
      })
    ).toEqual({
      attempts: [2, 2],
      phases: ['retry_scheduled', 'recovered'],
      writeSha256: createHash('sha256').update('Canary\n').digest('hex'),
    });
  });

  it('rejects a recovered production trajectory with a duplicate Write', () => {
    expect(() =>
      validateProductionWebRecoveryEvidence({
        sseEvents: [
          {
            type: 'pending.resume',
            properties: {
              phase: 'retry_scheduled',
              attempt: 1,
              maxAttempts: 4,
              delayMs: 1_000,
            },
          },
          {
            type: 'pending.resume',
            properties: { phase: 'recovered', attempt: 2, maxAttempts: 4 },
          },
          { type: 'session.completed', properties: {} },
        ],
        durableEvents: [],
        targetContent: 'Canary\n',
        targetPath: '/tmp/canary.txt',
        finalMarker: 'GUI_RECOVERED',
      })
    ).toThrow('exactly one Write');
  });

  it('preserves the safe diagnostic structure when evidence settles quickly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-web-diagnostic-fast-'));
    const secret = 'web-diagnostic-fast-secret';
    const projectPath = path.join(root, `workspace-${secret}`);
    const sessionId = `session-${secret}`;
    const target = path.join(projectPath, `target-${secret}.txt`);
    const controller = createSessionRouteController();
    const input = { controller, sessionId, projectPath, target };

    try {
      await mkdir(projectPath, { recursive: true });
      await writeFile(target, secret, { mode: 0o600 });
      await SessionService.createSessionMetadata(sessionId, projectPath, {
        taskStatus: 'running',
        selectedModelId: `model-${secret}`,
      });
      const store = new PersistentStore(projectPath);
      await store.saveMessage(sessionId, 'user', secret);
      const outcome = { kind: 'failure' } as const;
      const expected = await buildWebRecoveryDiagnostic(input, [], outcome);

      const diagnostic = await buildWebRecoveryDiagnosticBounded(
        input,
        [],
        outcome,
        200
      );

      expect(diagnostic).toBe(expected);
      expect(diagnostic).toContain('\"outcome\":\"failure\"');
      expect(diagnostic).toContain('\"taskStatus\":\"running\"');
      expect(diagnostic).toContain('\"targetBytes\":\"1_4096\"');
      expect(diagnostic).toContain('\"transcriptBytes\":\"1_4096\"');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(projectPath);
      expect(diagnostic).not.toContain(sessionId);
      expect(diagnostic).not.toContain(target);
    } finally {
      await controller.shutdown('fast Web diagnostic test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a fixed fallback when durable event evidence never settles', async () => {
    const secret = 'web-diagnostic-deadline-secret';
    const projectPath = `/private/workspace-${secret}`;
    const sessionId = `session-${secret}`;
    const controller = createSessionRouteController();
    const loadEventsSpy = vi
      .spyOn(PersistentStore.prototype, 'loadEvents')
      .mockImplementation(() => new Promise<never>(() => undefined));

    try {
      const startedAt = performance.now();
      const diagnostic = await buildWebRecoveryDiagnosticBounded(
        {
          controller,
          sessionId,
          projectPath,
          target: `${projectPath}/target-${secret}.txt`,
        },
        [],
        { kind: 'failure' },
        20
      );

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(diagnostic).toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(projectPath);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      loadEventsSpy.mockRestore();
      await controller.shutdown('bounded Web diagnostic test cleanup');
    }
  }, 1_000);

  it('returns a fixed fallback when evidence collection rejects quickly', async () => {
    const secret = 'web-diagnostic-rejection-secret';
    const projectPath = `/private/workspace-${secret}`;
    const sessionId = `session-${secret}`;
    const controller = createSessionRouteController();
    const loadEventsSpy = vi
      .spyOn(PersistentStore.prototype, 'loadEvents')
      .mockRejectedValue(new Error(`failed at ${projectPath}/${sessionId}/${secret}`));

    try {
      const diagnostic = await buildWebRecoveryDiagnosticBounded(
        {
          controller,
          sessionId,
          projectPath,
          target: `${projectPath}/target-${secret}.txt`,
        },
        [],
        { kind: 'failure' },
        200
      );

      expect(diagnostic).toBe('diagnostic unavailable');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(projectPath);
      expect(diagnostic).not.toContain(sessionId);
    } finally {
      loadEventsSpy.mockRestore();
      await controller.shutdown('rejected Web diagnostic test cleanup');
    }
  });

  it('bounds timeout evidence without serializing workspace or transcript content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-web-recovery-timeout-'));
    const secret = 'web-timeout-secret';
    const workspace = path.join(root, `workspace-${secret}`);
    const sessionId = `web-timeout-${secret}`;
    const target = path.join(workspace, `target-${secret}.txt`);
    const modelId = `private-timeout-model-${secret}`;
    const controller = createSessionRouteController();
    const originalTimeout = process.env.BLADE_DURABLE_WEB_RECOVERY_TIMEOUT_MS;

    try {
      process.env.BLADE_DURABLE_WEB_RECOVERY_TIMEOUT_MS = '5';
      await mkdir(workspace, { recursive: true });
      await writeFile(target, `private target content ${secret}`, { mode: 0o600 });
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'running',
        selectedModelId: modelId,
      });
      const store = new PersistentStore(workspace);
      await store.saveMessage(sessionId, 'user', `private durable prompt ${secret}`);
      const waiting = waitForWebRecovery({
        controller,
        sessionId,
        projectPath: workspace,
        target,
      });

      const failure = await waiting.promise.then(
        () => new Error('expected Web recovery timeout'),
        (error: unknown) => error
      );
      if (!(failure instanceof Error)) {
        throw new Error('Web recovery timeout was not an Error');
      }
      expect(failure.message).toContain(
        'Timed out waiting for durable Web interaction recovery'
      );
      expect(failure.message).toContain('"taskStatus":"running"');
      expect(failure.message).toContain('"targetBytes":"1_4096"');
      expect(failure.message).toContain('"transcriptBytes":"1_4096"');
      expect(failure.message).not.toContain('targetContent');
      expect(failure.message).not.toContain('transcriptTail');
      expect(failure.message).not.toContain('durableEvents');
      expect(failure.message).not.toContain('busEvents');
      expect(failure.message).not.toContain(secret);
      expect(failure.message).not.toContain(modelId);
      expect(failure.message).not.toContain(sessionId);
      expect(failure.message).not.toContain(workspace);
      expect(failure.message).not.toContain(target);
      expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(4_096);
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.BLADE_DURABLE_WEB_RECOVERY_TIMEOUT_MS;
      } else {
        process.env.BLADE_DURABLE_WEB_RECOVERY_TIMEOUT_MS = originalTimeout;
      }
      await controller.shutdown('durable Web timeout diagnostic cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('attaches bounded redacted evidence to an authoritative terminal failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-web-recovery-error-'));
    const workspace = path.join(root, 'workspace');
    const controller = createSessionRouteController();
    const sessionId = 'web-recovery-terminal-error';
    const secret = 'terminal-error-secret';
    const modelId = 'private-model-' + secret;
    const target = path.join(workspace, 'never-written.txt');
    const waiting = waitForWebRecovery({
      controller,
      sessionId,
      projectPath: workspace,
      target,
    });

    try {
      await mkdir(workspace, { recursive: true });
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'failed',
        selectedModelId: modelId,
      });
      Bus.publish({ sessionId, projectPath: workspace }, 'session.error', {
        error: 'Provider rejected this request. Check account and model permissions.',
        taskFailure: {
          code: 'permission',
          message:
            'Provider rejected this request. Check account and model permissions.',
          retryable: false,
        },
        unsafeDiagnostic: secret,
      });

      const failure = await waiting.promise.then(
        () => new Error('expected Web recovery to fail'),
        (error: unknown) => error
      );
      if (!(failure instanceof Error)) {
        throw new Error('Web recovery failure was not an Error');
      }
      expect(failure.message).toContain('Recovered Web interaction failed');
      expect(failure.message).toContain('\"code\":\"permission\"');
      expect(failure.message).toContain('\"busEventCounts\":{\"session.error\":1}');
      expect(failure.message).toContain('\"transcriptBytes\":\"1_4096\"');
      expect(failure.message).toMatch(/"selectedModelDigest":"[a-f0-9]{12}"/);
      expect(failure.message).not.toContain('unsafeDiagnostic');
      expect(failure.message).not.toContain('transcriptTail');
      expect(failure.message).not.toContain('targetContent');
      expect(failure.message).not.toContain(secret);
      expect(failure.message).not.toContain(modelId);
      expect(failure.message).not.toContain(sessionId);
      expect(failure.message).not.toContain(workspace);
      expect(failure.message).not.toContain(target);
      expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(4_096);
    } finally {
      waiting.cancel();
      await controller.shutdown('durable Web recovery diagnostic cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('production Chromium durable pending recovery (real API)', () => {
    it('recovers a one-shot DeepSeek failure through the visible Web UI', async () => {
      if (!deepseekFlash?.baseURL) throw new Error('DeepSeek Flash is unavailable');
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-web-chromium-'));
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const sessionId = 'interaction-chromium-' + Date.now();
      const target = path.join(workspace, 'gui-selected-channel.txt');
      const finalMarker = 'GUI_INTERACTION_RECOVERED';
      const proxy = await startRecordingProviderProxy(deepseekFlash.baseURL, {
        inject503Once: { path: '/v1/chat/completions', retryAfterMs: 60_000 },
        holdRequestNumber: 2,
        holdMs: 10_000,
      });
      const config = buildDurableInteractionRecoveryConfig(
        buildRealApiRuntimeConfig({
          ...deepseekFlash,
          baseURL: proxy.baseUrl,
        })
      );
      const port = await reserveProductionWebPort();
      const origin = 'http://127.0.0.1:' + port;
      let child: ChildProcess | undefined;
      let probe: ProductionEventProbe | undefined;
      let browser: Browser | undefined;
      let page: Page | undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const browserApplicationErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: string[] = [];
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const startedAt = Date.now();

      try {
        await Promise.all([
          mkdir(path.join(home, '.blade'), { recursive: true }),
          mkdir(workspace, { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
        ]);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          JSON.stringify(
            {
              currentModelId: config.currentModelId,
              models: config.models,
              modelProviders: config.modelProviders,
              permissionMode: 'yolo',
              providerForegroundRecoveryMs: config.providerForegroundRecoveryMs,
              providerRequestAdmissionMs: config.providerRequestAdmissionMs,
              providerCircuitBreakerOpenMs: 0,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          ) + '\n',
          { mode: 0o600 }
        );
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        await SessionService.createSessionMetadata(sessionId, workspace, {
          title: 'Pending Channel Decision',
          taskStatus: 'completed',
          selectedModelId: config.currentModelId,
          permissionMode: 'yolo',
        });
        const store = new PersistentStore(workspace);
        await store.saveMessage(
          sessionId,
          'user',
          [
            'A Channel question will be recovered in the production Web UI.',
            'After the recovered answer, call Write exactly once with file_path=' +
              JSON.stringify(target) +
              '.',
            'Set content to the selected label followed by exactly one newline.',
            'That Write is the only allowed tool call. Never call AskUserQuestion again.',
            'Do not emit assistant text or end the turn before Write succeeds.',
            'After Write succeeds, reply with the exact concatenation of ' +
              'GUI_INTERACTION_ and RECOVERED, with no separator.',
          ].join(' ')
        );
        const question = {
          header: 'Channel',
          question: 'Which release channel should Blade write?',
          multiSelect: false,
          options: [
            { label: 'Stable', description: 'Use the stable release channel' },
            { label: 'Canary', description: 'Use the early canary release channel' },
          ],
        };
        const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
          questions: [question],
        });
        await SessionInteractionService.request(
          {
            sessionId,
            projectPath: workspace,
            toolCallId,
            toolName: 'AskUserQuestion',
          },
          {
            type: 'askUserQuestion',
            message: 'Choose a release channel',
            questions: [question],
          }
        );

        child = spawn(
          process.execPath,
          [
            path.resolve(import.meta.dirname, '../../../dist/blade.js'),
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              HOME: home,
              BLADE_STORAGE_ROOT: storageRoot,
              BLADE_AUTO_MEMORY: '0',
              BLADE_TELEMETRY_DISABLED: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()));
        child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
        await waitForProductionCondition(
          async () => {
            try {
              return (await fetch(origin + '/health')).ok;
            } catch {
              return false;
            }
          },
          'Production Web qualification server did not become ready',
          30_000
        );
        probe = await openProductionEventProbe(origin, sessionId, workspace);
        await waitForProductionCondition(
          () =>
            probe?.events.some((event) => event.type === 'question.required') === true,
          'Exact Session SSE did not replay the durable question',
          20_000
        );
        const persistedSessionResponse = await fetch(
          origin +
            '/sessions/' +
            sessionId +
            '?projectPath=' +
            encodeURIComponent(workspace)
        );
        if (!persistedSessionResponse.ok) {
          throw new Error(
            'Production server could not load seeded Session: ' +
              persistedSessionResponse.status
          );
        }
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        await page.addInitScript(() => {
          const NativeEventSource = window.EventSource;
          class RecordingEventSource extends NativeEventSource {
            constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
              super(url, eventSourceInitDict);
              this.addEventListener('message', (event) => {
                try {
                  const parsed = JSON.parse(event.data) as { type?: unknown };
                  const target = window as typeof window & {
                    __bladeQualificationEventTypes?: string[];
                  };
                  if (!target.__bladeQualificationEventTypes) {
                    target.__bladeQualificationEventTypes = [];
                  }
                  if (typeof parsed.type === 'string') {
                    target.__bladeQualificationEventTypes.push(parsed.type);
                  }
                } catch {
                  // The application owns event parsing; this probe records only safe types.
                }
              });
            }
          }
          window.EventSource = RecordingEventSource;
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') browserApplicationErrors.push(message.text());
        });
        page.on('requestfailed', (request) => {
          failedRequests.push(request.method() + ' ' + new URL(request.url()).pathname);
        });
        const navigation = new URL(origin);
        navigation.searchParams.set('session', sessionId);
        navigation.searchParams.set('project', workspace);
        await page.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        const pendingQuestion = page.locator('[data-pending-interaction="question"]');
        try {
          await pendingQuestion.waitFor({ state: 'visible', timeout: 30_000 });
        } catch (error) {
          const diagnostic = await buildProductionWebRecoveryDiagnosticBounded({
            outcome: 'timeout',
            startedAt,
            page,
            probe,
            proxy,
            store,
            sessionId,
            projectPath: workspace,
            target,
            finalMarker,
            child,
            stdout,
            stderr,
            browserApplicationErrorCount: browserApplicationErrors.length,
            pageErrorCount: pageErrors.length,
            failedRequestCount: failedRequests.length,
          });
          throw new Error(`Pending question was not visible: ${diagnostic}`, {
            cause: error,
          });
        }
        await pendingQuestion.getByText('Canary', { exact: true }).click();
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().includes('/permissions/')
        );
        await pendingQuestion.getByText('Submit answers', { exact: true }).click();
        const answerResponse = await responsePromise;
        if (!answerResponse.ok()) {
          throw new Error('Question response failed: ' + answerResponse.status());
        }
        await waitForProductionCondition(
          () =>
            probe?.events.some(
              (event) =>
                event.type === 'pending.resume' &&
                event.properties.phase === 'retry_scheduled'
            ) === true,
          'Production Web SSE missed pending.resume retry_scheduled',
          60_000
        );
        await waitForProductionCondition(
          () => proxy.heldRequestNumbers.includes(2),
          'Second outer attempt did not reach the Provider hold',
          30_000
        );
        await page.getByText('Recovery attempt 2/4', { exact: false }).waitFor({
          state: 'visible',
          timeout: 15_000,
        });
        proxy.releaseHeld();
        try {
          await waitForProductionWebFinalMarker(
            page,
            probe.events,
            finalMarker,
            150_000
          );
        } catch (error) {
          const terminalFailure = findProductionWebTerminalFailure(probe.events);
          const diagnostic = await buildProductionWebRecoveryDiagnosticBounded({
            outcome: terminalFailure ? 'terminal_failure' : 'timeout',
            startedAt,
            page,
            probe,
            proxy,
            store,
            sessionId,
            projectPath: workspace,
            target,
            finalMarker,
            child,
            stdout,
            stderr,
            browserApplicationErrorCount: browserApplicationErrors.length,
            pageErrorCount: pageErrors.length,
            failedRequestCount: failedRequests.length,
          });
          throw new Error(
            `Production Web recovery did not render its final marker: ${diagnostic}`,
            { cause: error }
          );
        }
        await waitForProductionCondition(
          () =>
            probe?.events.filter((event) => event.type === 'session.completed')
              .length === 1,
          'Production Web SSE missed session.completed',
          30_000
        );

        const durableEvents = (await store.loadEvents(sessionId)) ?? [];
        const transcript = await readFile(
          getSessionFilePath(workspace, sessionId),
          'utf8'
        );
        const targetContent = await readFile(target, 'utf8');
        const result = validateProductionWebRecoveryEvidence({
          sseEvents: probe.events,
          durableEvents,
          targetContent,
          targetPath: target,
          finalMarker,
        });
        expect(result.writeSha256).toBe(
          createHash('sha256').update('Canary\n').digest('hex')
        );
        expect(proxy.injectedRequestNumbers).toEqual([1]);
        expect(proxy.heldRequestNumbers).toEqual([2]);
        expect(proxy.forwardedRequestNumbers).toContain(2);
        expect(await fileIsMissing(getSessionInboxFilePath(workspace, sessionId))).toBe(
          true
        );
        expect(browserApplicationErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        expect(Buffer.byteLength(stdout.join(''))).toBeLessThanOrEqual(64 * 1_024);
        expect(Buffer.byteLength(stderr.join(''))).toBeLessThanOrEqual(64 * 1_024);
        const completedDom = await page.locator('body').innerText();

        await page.close();
        page = undefined;
        const reloadContext = await browser.newContext();
        const reloadPage = await reloadContext.newPage();
        await reloadPage.goto(navigation.href, { waitUntil: 'domcontentloaded' });
        await reloadPage.getByText(finalMarker, { exact: true }).waitFor({
          state: 'visible',
          timeout: 30_000,
        });
        expect(
          await reloadPage.locator('[data-pending-interaction="question"]').count()
        ).toBe(0);
        expect(
          await reloadPage.getByText('Recovery attempt', { exact: false }).count()
        ).toBe(0);
        const reloadedDom = await reloadPage.locator('body').innerText();
        await reloadContext.close();

        assertNoSecrets(
          {
            transcript,
            completedDom,
            reloadedDom,
            sse: probe.events,
            stdout: stdout.join(''),
            stderr: stderr.join(''),
            proxy: {
              paths: proxy.requestPaths,
              injected: proxy.injectedRequestNumbers,
              forwarded: proxy.forwardedRequestNumbers,
              held: proxy.heldRequestNumbers,
            },
          },
          [deepseekFlash.apiKey]
        );
      } finally {
        await probe?.close().catch(() => undefined);
        await page?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await waitForProductionChildExit(child).catch(() => child?.kill('SIGKILL'));
        }
        proxy.releaseHeld();
        await proxy.close().catch(() => undefined);
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        await rm(root, { recursive: true, force: true });
      }
    }, 360_000);
  });

describeReal('durable pending interaction recovery trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('restarts from a durable Web question and performs a real Write', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-interaction-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const target = path.join(workspace, 'selected-channel.txt');
    const sessionId = `interaction-web-${Date.now()}`;
    const originalConfig = getState().config.config;
    const config = buildDurableInteractionRecoveryConfig({
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    });
    const controller = createSessionRouteController();
    const app = new Hono();
    app.route('/sessions', controller.app);
    app.route('/permissions', PermissionRoutes());

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await mkdir(workspace, { recursive: true });
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const store = new PersistentStore(workspace);
      await store.saveMessage(
        sessionId,
        'user',
        [
          'A structured Channel question will be recovered after a process restart.',
          `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
            target
          )}.`,
          'Set content to the selected label followed by exactly one newline.',
          'That Write is the only allowed tool call. Never call AskUserQuestion again.',
          'Do not emit assistant text or end the turn before Write succeeds.',
          'After Write succeeds, reply exactly INTERACTION_RECOVERED.',
        ].join(' ')
      );
      const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable release' },
              { label: 'Canary', description: 'Canary release' },
            ],
          },
        ],
      });
      const request = await SessionInteractionService.request(
        {
          sessionId,
          projectPath: workspace,
          toolCallId,
          toolName: 'AskUserQuestion',
        },
        {
          type: 'askUserQuestion',
          message: 'Choose a release channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Stable release' },
                { label: 'Canary', description: 'Canary release' },
              ],
            },
          ],
        }
      );
      await expect(
        SessionService.findSessionMetadata(sessionId, workspace)
      ).resolves.toMatchObject({
        pendingInteraction: {
          type: 'question',
          requestId: request.requestId,
        },
      });

      const completion = waitForWebRecovery({
        controller,
        sessionId,
        projectPath: workspace,
        target,
      });
      const response = await runWithCwdOverride(workspace, () =>
        app.request(
          `/permissions/${request.requestId}?sessionId=${sessionId}&projectPath=${encodeURIComponent(
            workspace
          )}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              approved: true,
              answers: { Channel: 'Canary' },
            }),
          }
        )
      );
      if (response.status !== 200) completion.cancel();
      expect(response.status, await response.clone().text()).toBe(200);
      await completion.promise;

      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      const metadata = await SessionService.findSessionMetadata(sessionId, workspace);
      assertNoSecrets({ metadata, transcript }, [gpt.apiKey]);
      const targetContent = await readOptionalFile(target);
      const diagnostic = await buildWebRecoveryDiagnosticBounded(
        {
          controller,
          sessionId,
          projectPath: workspace,
          target,
        },
        [],
        { kind: 'failure' }
      );
      expect(
        targetContent,
        `Recovered Web interaction did not commit the selected file: ${diagnostic}`
      ).toBe('Canary\n');
      expect(transcript.match(/"type":"interaction_requested"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_responded"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_recovered"/g)).toHaveLength(1);
      expect(transcript.match(/"interactionRecovery":true/g)).toHaveLength(1);
    } finally {
      await controller.shutdown('durable Web interaction qualification cleanup');
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);

  it('replays a durable ACP question on session/load and resumes automatically', async () => {
    if (!deepseek) throw new Error('DeepSeek qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-acp-interaction-'));
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const target = path.join(workspace, 'acp-selected-channel.txt');
    const sessionId = `interaction-acp-${Date.now()}`;
    const originalConfig = getState().config.config;
    const config = buildDurableInteractionRecoveryConfig({
      ...buildRealApiRuntimeConfig(deepseek),
      permissionMode: PermissionMode.DEFAULT,
    });
    const client = createMockACPClient();
    client.requestPermission = async (request) => {
      client.permissionRequests.push(request);
      const selected = request.options.find((option) => option.name === 'Stable');
      return {
        outcome: {
          outcome: 'selected',
          optionId: selected?.optionId,
        },
      };
    };
    const agent = new BladeAgent(client as never);

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      await mkdir(workspace, { recursive: true });
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const store = new PersistentStore(workspace);
      await store.saveMessage(
        sessionId,
        'user',
        [
          'A Channel question will be recovered by ACP session/load.',
          `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
            target
          )}.`,
          'Set content to the selected label followed by exactly one newline.',
          'That Write is the only allowed tool call. Never call AskUserQuestion again.',
          'Do not emit assistant text or end the turn before Write succeeds.',
          'After Write succeeds, reply exactly ACP_INTERACTION_RECOVERED.',
        ].join(' ')
      );
      const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable release' },
              { label: 'Canary', description: 'Canary release' },
            ],
          },
        ],
      });
      await SessionInteractionService.request(
        {
          sessionId,
          projectPath: workspace,
          toolCallId,
          toolName: 'AskUserQuestion',
        },
        {
          type: 'askUserQuestion',
          message: 'Choose a release channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Stable release' },
                { label: 'Canary', description: 'Canary release' },
              ],
            },
          ],
        }
      );

      const setup = await runWithCwdOverride(workspace, () =>
        agent.loadSession({
          sessionId,
          cwd: workspace,
          mcpServers: [],
        })
      );
      expect(setup.modes?.currentModeId).toBe('yolo');
      expect(client.permissionRequests).toHaveLength(1);
      expect(
        client.permissionRequests[0]?.options.map((option) => option.name)
      ).toEqual(['Stable', 'Canary', 'Cancel']);
      const content = await waitForAcpRecovery({
        client,
        target,
        workspace,
        sessionId,
        expectedContent: 'Stable\n',
        expectedText: 'ACP_INTERACTION_RECOVERED',
      });
      expect(content).toBe('Stable\n');
      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      expect(transcript).toContain('ACP_INTERACTION_RECOVERED');
      expect(transcript.match(/"type":"interaction_requested"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_responded"/g)).toHaveLength(1);
      expect(transcript.match(/"type":"interaction_recovered"/g)).toHaveLength(1);
      assertNoSecrets(
        {
          setup,
          updates: client.sessionUpdates,
          requests: client.permissionRequests,
          transcript,
        },
        [deepseek.apiKey]
      );
    } finally {
      await agent.destroy().catch(() => undefined);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
