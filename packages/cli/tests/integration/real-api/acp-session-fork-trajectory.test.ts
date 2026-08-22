import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  assertForkChildToolTrace,
  assertForkLineage,
  assertForkParentToolTrace,
  assertNoSecrets,
  cleanupForkFixture,
  createForkFixture,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  releaseBlockingModels,
  resolveForkQualificationModels,
} from './testConfig.js';

type NotificationPredicate = (notification: acp.SessionNotification) => boolean;

interface PendingNotificationWaiter {
  predicate: NotificationPredicate;
  resolve(notification: acp.SessionNotification): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaitOptions {
  afterIndex?: number;
  timeoutMs?: number;
}

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];
  private readonly waiters = new Set<PendingNotificationWaiter>();
  private closed = false;

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    if (this.closed) return;
    this.updates.push(params);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(params)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(params);
    }
  }

  waitForNotification(
    predicate: NotificationPredicate,
    options: NotificationWaitOptions = {}
  ): Promise<acp.SessionNotification> {
    const afterIndex = options.afterIndex ?? 0;
    const timeoutMs = options.timeoutMs ?? 1_000;
    if (this.closed) {
      return Promise.reject(new Error('recording client closed'));
    }
    if (
      !Number.isInteger(afterIndex) ||
      afterIndex < 0 ||
      afterIndex > this.updates.length
    ) {
      return Promise.reject(new Error('notification boundary is invalid'));
    }
    const existing = this.updates.slice(afterIndex).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter: PendingNotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('timed out waiting for ACP session notification'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('recording client closed'));
    }
    this.waiters.clear();
  }
}

interface PairedAcpHarness {
  client: RecordingClient;
  connection: acp.ClientSideConnection;
  close(options?: { deadlineAt?: number }): Promise<void>;
  forceClose(options?: { deadlineAt?: number }): Promise<void>;
  cleanupCompleted(): boolean;
}

interface AcpPromptStageHarness {
  connection: Pick<acp.ClientSideConnection, 'prompt' | 'cancel'>;
}

const ACP_FORK_STAGE_TIMEOUT_MS = 270_000;
const ACP_FORK_CANCEL_GRACE_MS = 15_000;
const ACP_FORK_TRAJECTORY_BUDGET_MS = 390_000;
const ACP_FORK_CLEANUP_TIMEOUT_MS = 30_000;
const ACP_FORK_GRACEFUL_CLOSE_MAX_MS = 20_000;
const ACP_FORK_FORCE_CLOSE_RESERVE_MS = 10_000;
const ACP_FORK_RPC_MAX_MS = 60_000;
const ACP_FORK_NOTIFICATION_MAX_MS = 10_000;
const ACP_FORK_LIST_MAX_PAGES = 100;

class AcpForkStageTimeoutError extends Error {
  constructor(
    readonly stage: 'parent' | 'child',
    readonly timeoutMs: number
  ) {
    super(`ACP fork ${stage} prompt exceeded ${timeoutMs}ms`);
    this.name = 'AcpForkStageTimeoutError';
  }
}

type AcpForkCleanupPhase =
  | 'agent_destroy'
  | 'graceful_close'
  | 'client_to_agent_close'
  | 'agent_to_client_close'
  | 'client_to_agent_abort'
  | 'agent_to_client_abort'
  | 'client_to_agent_cancel'
  | 'agent_to_client_cancel'
  | 'client_connection_closed'
  | 'agent_connection_closed';

type AcpForkWritableClosePhase = Extract<
  AcpForkCleanupPhase,
  'client_to_agent_close' | 'agent_to_client_close'
>;

type AcpForkOperationPhase =
  | 'initialize'
  | 'new_session'
  | 'parent_commands_notification'
  | 'parent_set_mode'
  | 'list_sessions'
  | 'fork_session'
  | 'child_set_mode'
  | 'child_commands_notification';

type AcpForkNotificationPhase = Extract<
  AcpForkOperationPhase,
  'parent_commands_notification' | 'child_commands_notification'
>;

class AcpForkCleanupTimeoutError extends Error {
  constructor(timeoutMs: number, pending: readonly AcpForkCleanupPhase[]) {
    super(`ACP fork cleanup exceeded ${timeoutMs}ms; pending=${pending.join(',')}`);
    this.name = 'AcpForkCleanupTimeoutError';
  }
}

export async function runBoundedAcpForkCleanup(
  operations: ReadonlyArray<{
    phase: AcpForkCleanupPhase;
    run(): void | Promise<void>;
  }>,
  timeoutMs: number
): Promise<void> {
  const pending = new Set<AcpForkCleanupPhase>();
  const executions = operations.map(({ phase, run }) => {
    pending.add(phase);
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(run());
    } catch {
      operation = Promise.reject(new Error('cleanup operation rejected'));
    }
    return operation
      .then(
        () => ({ phase, failed: false }),
        () => ({ phase, failed: true })
      )
      .finally(() => pending.delete(phase));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.all(executions).then((results) => ({
      kind: 'settled' as const,
      results,
    })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, timeoutMs));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (outcome.kind === 'timeout') {
    throw new AcpForkCleanupTimeoutError(timeoutMs, [...pending]);
  }
  const failed = outcome.results.find((result) => result.failed);
  if (failed) {
    throw new Error(`ACP fork cleanup failed; phase=${failed.phase}`);
  }
}

class AcpForkOperationTimeoutError extends Error {
  constructor(readonly phase: AcpForkOperationPhase) {
    super(`ACP fork operation timed out; phase=${phase}`);
    this.name = 'AcpForkOperationTimeoutError';
  }
}

interface SafeAcpFailureMetadata {
  rpcCode: number | undefined;
  failureType: string | undefined;
  taskFailureCode: string | undefined;
  taskFailureRetryable: boolean | undefined;
}

function safeAcpFailureMetadata(error: unknown): SafeAcpFailureMetadata {
  const candidate = isRecord(error) ? error : undefined;
  const rpcCode =
    typeof candidate?.code === 'number' && Number.isSafeInteger(candidate.code)
      ? candidate.code
      : undefined;
  const data = isRecord(candidate?.data) ? candidate.data : undefined;
  const failureType =
    typeof data?.failureType === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/.test(data.failureType)
      ? data.failureType
      : undefined;
  const taskFailure = isRecord(data?.taskFailure) ? data.taskFailure : undefined;
  const taskFailureCode =
    typeof taskFailure?.code === 'string' &&
    [
      'authentication',
      'permission',
      'rate_limit',
      'timeout',
      'network',
      'model_unavailable',
      'context_limit',
      'unsupported_input',
      'capacity',
      'runtime',
    ].includes(taskFailure.code)
      ? taskFailure.code
      : undefined;
  const taskFailureRetryable =
    typeof taskFailure?.retryable === 'boolean' ? taskFailure.retryable : undefined;
  return { rpcCode, failureType, taskFailureCode, taskFailureRetryable };
}

function formatSafeAcpFailure(metadata: SafeAcpFailureMetadata): string {
  return (
    `rpc_code=${metadata.rpcCode ?? 'unknown'}; ` +
    `failure_type=${metadata.failureType ?? 'unknown'}; ` +
    `task_failure=${metadata.taskFailureCode ?? 'unknown'}; ` +
    `retryable=${
      metadata.taskFailureRetryable === undefined
        ? 'unknown'
        : metadata.taskFailureRetryable
          ? 'true'
          : 'false'
    }`
  );
}

function resolveAcpForkOperationTimeout(input: {
  deadlineAt: number;
  maxMs: number;
  reserveMs: number;
  now?: number;
}): number {
  return Math.min(
    input.maxMs,
    Math.max(0, input.deadlineAt - (input.now ?? Date.now()) - input.reserveMs)
  );
}

async function runAcpForkOperationWithTimeout<Result>(input: {
  phase: AcpForkOperationPhase;
  timeoutMs: number;
  run(): Result | Promise<Result>;
}): Promise<Result> {
  if (input.timeoutMs <= 0) {
    throw new Error(`ACP fork operation has no remaining budget; phase=${input.phase}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AcpForkOperationTimeoutError(input.phase)),
      input.timeoutMs
    );
  });
  let operation: Promise<Result>;
  try {
    operation = Promise.resolve(input.run());
  } catch (error) {
    if (timer) clearTimeout(timer);
    throw new Error(
      `ACP fork operation failed; phase=${input.phase}; ${formatSafeAcpFailure(
        safeAcpFailureMetadata(error)
      )}`
    );
  }

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof AcpForkOperationTimeoutError) throw error;
    throw new Error(
      `ACP fork operation failed; phase=${input.phase}; ${formatSafeAcpFailure(
        safeAcpFailureMetadata(error)
      )}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function runAcpForkOperation<Result>(input: {
  phase: AcpForkOperationPhase;
  deadlineAt: number;
  maxMs: number;
  reserveMs: number;
  run(): Result | Promise<Result>;
}): Promise<Result> {
  return runAcpForkOperationWithTimeout({
    phase: input.phase,
    timeoutMs: resolveAcpForkOperationTimeout(input),
    run: input.run,
  });
}

function waitForAcpForkNotification(input: {
  client: RecordingClient;
  predicate: NotificationPredicate;
  afterIndex?: number;
  phase: AcpForkNotificationPhase;
  deadlineAt: number;
  maxMs: number;
  reserveMs: number;
}): Promise<acp.SessionNotification> {
  const timeoutMs = resolveAcpForkOperationTimeout(input);
  return runAcpForkOperationWithTimeout({
    phase: input.phase,
    timeoutMs,
    run: () =>
      input.client.waitForNotification(input.predicate, {
        afterIndex: input.afterIndex,
        timeoutMs,
      }),
  });
}

export function describeAcpForkPromptFailure(
  error: unknown,
  stage: 'parent' | 'child'
): string {
  return `ACP fork ${stage} prompt failed; ${formatSafeAcpFailure(
    safeAcpFailureMetadata(error)
  )}`;
}

export function resolveAcpForkStageTimeout(input: {
  deadlineAt: number;
  maxStageMs: number;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  return Math.max(0, Math.min(input.maxStageMs, input.deadlineAt - now));
}

export function resolveAcpForkPhaseBudgets(input: {
  deadlineAt: number;
  maxStageMs: number;
  cancelGraceMs: number;
  cleanupReserveMs: number;
  now?: number;
}): { promptMs: number; cancelMs: number; cleanupMs: number } {
  const remaining = Math.max(0, input.deadlineAt - (input.now ?? Date.now()));
  const cleanupMs = Math.min(input.cleanupReserveMs, remaining);
  const beforeCleanup = Math.max(0, remaining - cleanupMs);
  const cancelMs = Math.min(input.cancelGraceMs, beforeCleanup);
  const promptMs = Math.min(input.maxStageMs, Math.max(0, beforeCleanup - cancelMs));
  return { promptMs, cancelMs, cleanupMs };
}

export function resolveAcpForkCleanupBudgets(input: {
  deadlineAt: number;
  gracefulMaxMs: number;
  forceReserveMs: number;
  now?: number;
}): { gracefulMs: number; forceMs: number } {
  const remaining = Math.max(0, input.deadlineAt - (input.now ?? Date.now()));
  const forceMs = Math.min(input.forceReserveMs, remaining);
  const gracefulMs = Math.min(input.gracefulMaxMs, Math.max(0, remaining - forceMs));
  return { gracefulMs, forceMs };
}

class ManagedAcpForkWritable {
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private closePromise: Promise<void> | undefined;
  private abortPromise: Promise<void> | undefined;

  constructor(
    private readonly writable: WritableStream<Uint8Array>,
    private readonly closePhase: AcpForkWritableClosePhase,
    private readonly beforeClose?: (
      phase: AcpForkWritableClosePhase
    ) => void | Promise<void>
  ) {}

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const writer = this.writable.getWriter();
    this.writer = writer;
    const attempt = (async () => {
      try {
        await this.beforeClose?.(this.closePhase);
        await writer.close();
      } finally {
        await this.abortPromise?.catch(() => undefined);
        if (this.writer === writer) {
          writer.releaseLock();
          this.writer = undefined;
        }
      }
    })();
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      if (this.closePromise === tracked) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = tracked;
    return this.closePromise;
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    let attempt: Promise<void>;
    try {
      attempt = this.writer ? this.writer.abort() : this.writable.abort();
    } catch {
      attempt = Promise.reject(new Error('managed writable abort failed'));
    }
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      if (this.abortPromise === tracked) this.abortPromise = undefined;
      throw error;
    });
    this.abortPromise = tracked;
    return this.abortPromise;
  }
}

async function runPromptStage(
  harness: AcpPromptStageHarness,
  params: acp.PromptRequest,
  stage: 'parent' | 'child',
  options: {
    timeoutMs?: number;
    cancelGraceMs?: number;
    deadlineAt?: number;
  } = {}
): Promise<acp.PromptResponse> {
  const maxStageMs = options.timeoutMs ?? ACP_FORK_STAGE_TIMEOUT_MS;
  const configuredCancelGraceMs = options.cancelGraceMs ?? ACP_FORK_CANCEL_GRACE_MS;
  const phaseBudgets =
    options.deadlineAt === undefined
      ? {
          promptMs: maxStageMs,
          cancelMs: configuredCancelGraceMs,
        }
      : resolveAcpForkPhaseBudgets({
          deadlineAt: options.deadlineAt,
          maxStageMs,
          cancelGraceMs: configuredCancelGraceMs,
          cleanupReserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
        });
  const timeoutMs = phaseBudgets.promptMs;
  const cancelGraceMs = phaseBudgets.cancelMs;
  if (timeoutMs <= 0) {
    throw new Error(`ACP fork ${stage} prompt has no remaining trajectory budget`);
  }
  const prompt = harness.connection.prompt(params);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AcpForkStageTimeoutError(stage, timeoutMs)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([prompt, timeout]);
  } catch (error) {
    if (!(error instanceof AcpForkStageTimeoutError)) {
      throw new Error(describeAcpForkPromptFailure(error, stage));
    }
    const cancelSent = Promise.resolve()
      .then(() => harness.connection.cancel({ sessionId: params.sessionId }))
      .then(
        () => true,
        () => false
      );
    const promptSettled = prompt.then(
      () => true,
      () => true
    );
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.all([cancelSent, promptSettled]).then(
        ([sent, promptDone]) => sent && promptDone
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), cancelGraceMs);
      }),
    ]).finally(() => {
      if (graceTimer) clearTimeout(graceTimer);
    });
    if (!settled) {
      throw new Error(
        `ACP fork ${stage} cancellation did not settle within ${cancelGraceMs}ms`
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createPairedHarness(
  client = new RecordingClient(),
  options: {
    destroyAgent?: () => Promise<void>;
    beforeWritableClose?: (phase: AcpForkWritableClosePhase) => void | Promise<void>;
  } = {}
): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;

  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (productionConnection) => {
      agent = new BladeAgent(productionConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  const productionAgent = agent;
  let destroyPromise: Promise<void> | undefined;
  const destroyAgent = (): Promise<void> => {
    if (destroyPromise) return destroyPromise;
    const attempt = (async () => {
      await options.destroyAgent?.();
      await productionAgent.destroy();
    })();
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      if (destroyPromise === tracked) destroyPromise = undefined;
      throw error;
    });
    destroyPromise = tracked;
    return destroyPromise;
  };
  let closePromise: Promise<void> | undefined;
  let forceClosePromise: Promise<void> | undefined;
  let cleanupCompleted = false;
  const clientToAgentWritable = new ManagedAcpForkWritable(
    clientToAgent.writable,
    'client_to_agent_close',
    options.beforeWritableClose
  );
  const agentToClientWritable = new ManagedAcpForkWritable(
    agentToClient.writable,
    'agent_to_client_close',
    options.beforeWritableClose
  );
  let clientToAgentCancelPromise: Promise<void> | undefined;
  let agentToClientCancelPromise: Promise<void> | undefined;
  let gracefulConvergencePromise: Promise<void> | undefined;
  const cancelClientToAgent = (): Promise<void> => {
    clientToAgentCancelPromise ??= clientToAgent.readable
      .cancel()
      .catch(() => undefined);
    return clientToAgentCancelPromise;
  };
  const cancelAgentToClient = (): Promise<void> => {
    agentToClientCancelPromise ??= agentToClient.readable
      .cancel()
      .catch(() => undefined);
    return agentToClientCancelPromise;
  };
  const ensureGracefulConvergence = (): Promise<void> => {
    if (gracefulConvergencePromise) return gracefulConvergencePromise;
    const attempt = (async () => {
      await destroyAgent();
      await Promise.all([clientToAgentWritable.close(), agentToClientWritable.close()]);
      await Promise.all([connection.closed, agentConnection.closed]);
      cleanupCompleted = true;
    })();
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      if (gracefulConvergencePromise === tracked) {
        gracefulConvergencePromise = undefined;
      }
      throw error;
    });
    gracefulConvergencePromise = tracked;
    return gracefulConvergencePromise;
  };

  return {
    client,
    connection,
    forceClose: (options = {}) => {
      if (cleanupCompleted) return Promise.resolve();
      if (forceClosePromise) return forceClosePromise;
      const attempt = (async () => {
        client.close();
        const deadlineAt =
          options.deadlineAt === undefined
            ? Date.now() + ACP_FORK_FORCE_CLOSE_RESERVE_MS
            : options.deadlineAt;
        const clientToAgentAbort = clientToAgentWritable.abort();
        const agentToClientAbort = agentToClientWritable.abort();
        const clientToAgentCancel = cancelClientToAgent();
        const agentToClientCancel = cancelAgentToClient();
        const agentDestroy = destroyAgent();
        const clientConnectionClosed = connection.closed;
        const agentConnectionClosed = agentConnection.closed;
        const convergenceObservation = Promise.all([
          clientToAgentAbort,
          agentToClientAbort,
          clientToAgentCancel,
          agentToClientCancel,
          agentDestroy,
          clientConnectionClosed,
          agentConnectionClosed,
        ]).then(
          () => {
            cleanupCompleted = true;
            return true;
          },
          () => false
        );
        await runBoundedAcpForkCleanup(
          [
            {
              phase: 'client_to_agent_abort',
              run: () => clientToAgentAbort,
            },
            {
              phase: 'agent_to_client_abort',
              run: () => agentToClientAbort,
            },
            {
              phase: 'client_to_agent_cancel',
              run: () => clientToAgentCancel,
            },
            {
              phase: 'agent_to_client_cancel',
              run: () => agentToClientCancel,
            },
            { phase: 'agent_destroy', run: () => agentDestroy },
          ],
          Math.max(0, deadlineAt - Date.now())
        );
        await runBoundedAcpForkCleanup(
          [
            {
              phase: 'client_connection_closed',
              run: () => clientConnectionClosed,
            },
            {
              phase: 'agent_connection_closed',
              run: () => agentConnectionClosed,
            },
          ],
          Math.max(0, deadlineAt - Date.now())
        );
        if (!(await convergenceObservation)) {
          throw new Error('ACP fork cleanup failed; phase=force_convergence');
        }
        cleanupCompleted = true;
      })();
      const tracked = attempt.finally(() => {
        if (!cleanupCompleted && forceClosePromise === tracked) {
          forceClosePromise = undefined;
        }
      });
      forceClosePromise = tracked;
      return forceClosePromise;
    },
    close: (options = {}) => {
      if (cleanupCompleted) return Promise.resolve();
      if (closePromise) return closePromise;
      const attempt = (async () => {
        try {
          client.close();
          const cleanupTimeoutMs =
            options.deadlineAt === undefined
              ? ACP_FORK_GRACEFUL_CLOSE_MAX_MS
              : resolveAcpForkCleanupBudgets({
                  deadlineAt: options.deadlineAt,
                  gracefulMaxMs: ACP_FORK_GRACEFUL_CLOSE_MAX_MS,
                  forceReserveMs: ACP_FORK_FORCE_CLOSE_RESERVE_MS,
                }).gracefulMs;
          await runBoundedAcpForkCleanup(
            [{ phase: 'graceful_close', run: ensureGracefulConvergence }],
            cleanupTimeoutMs
          );
          cleanupCompleted = true;
        } catch {
          cleanupCompleted = false;
          throw new Error('ACP fork graceful cleanup failed; phase=close');
        }
      })();
      const tracked = attempt.finally(() => {
        if (!cleanupCompleted && closePromise === tracked) {
          closePromise = undefined;
        }
      });
      closePromise = tracked;
      return closePromise;
    },
    cleanupCompleted: () => cleanupCompleted,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeParentTrace(
  trace: ReturnType<typeof extractDurableToolTrace>,
  expectedPath: string
): {
  traceLength: number;
  records: Array<{
    toolName: string;
    inputKeys: string[];
    filePath: {
      basename: string | null;
      isAbsolute: boolean;
      equalsExpected: boolean;
    };
    outputType: string;
    outputNull: boolean;
    errorNull: boolean;
  }>;
} {
  return {
    traceLength: trace.length,
    records: trace.map((record) => {
      const input = isRecord(record.input) ? record.input : undefined;
      const filePath = typeof input?.file_path === 'string' ? input.file_path : null;
      return {
        toolName: record.toolName,
        inputKeys: input ? Object.keys(input).sort() : [],
        filePath: {
          basename: filePath === null ? null : path.basename(filePath),
          isAbsolute: filePath === null ? false : path.isAbsolute(filePath),
          equalsExpected: filePath === expectedPath,
        },
        outputType: record.output === null ? 'null' : typeof record.output,
        outputNull: record.output === null,
        errorNull: record.error === null,
      };
    }),
  };
}

function assertStrictParentTrace(
  trace: ReturnType<typeof extractDurableToolTrace>,
  memoryPath: string
): void {
  try {
    assertForkParentToolTrace(trace, memoryPath);
  } catch {
    throw new Error(
      `ACP parent durable trace rejected: ${JSON.stringify(
        describeParentTrace(trace, memoryPath)
      )}`
    );
  }
}

function assertKnownForkNotificationSessions(
  notifications: readonly acp.SessionNotification[],
  parentId: string,
  childId: string
): void {
  const foreign = notifications.find(
    (notification) =>
      notification.sessionId !== parentId && notification.sessionId !== childId
  );
  if (foreign) {
    throw new Error('ACP fork window contains a foreign session notification');
  }
}

function assertAllNotificationsForSession(
  notifications: readonly acp.SessionNotification[],
  expectedSessionId: string
): void {
  if (notifications.length === 0) {
    throw new Error('ACP notification ownership window must not be empty');
  }
  if (
    notifications.some((notification) => notification.sessionId !== expectedSessionId)
  ) {
    throw new Error('ACP notification ownership window contains an unexpected session');
  }
}

describe('ACP recording client lifecycle', () => {
  it('bounds ACP operations, skips exhausted work, and sanitizes failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let pendingRunCount = 0;
      const pending = runAcpForkOperation({
        phase: 'initialize',
        deadlineAt: 1_100,
        maxMs: 20,
        reserveMs: 0,
        run: () => {
          pendingRunCount += 1;
          return new Promise<number>(() => undefined);
        },
      });
      const pendingFailure = pending.then(
        () => new Error('expected pending operation to time out'),
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(20);
      await expect(pendingFailure).resolves.toMatchObject({
        message: 'ACP fork operation timed out; phase=initialize',
      });
      expect(pendingRunCount).toBe(1);

      let exhaustedRunCount = 0;
      const exhausted = runAcpForkOperation({
        phase: 'new_session',
        deadlineAt: Date.now(),
        maxMs: 20,
        reserveMs: 0,
        run: async () => {
          exhaustedRunCount += 1;
          return 1;
        },
      });
      await expect(exhausted).rejects.toThrow(
        'ACP fork operation has no remaining budget; phase=new_session'
      );
      expect(exhaustedRunCount).toBe(0);

      const secret = 'rpc-secret-must-not-appear';
      const rejected = runAcpForkOperation({
        phase: 'fork_session',
        deadlineAt: Date.now() + 100,
        maxMs: 20,
        reserveMs: 0,
        run: () =>
          Promise.reject(
            Object.assign(new Error(`/private/${secret}`), {
              code: -32603,
              data: {
                failureType: 'api_error',
                taskFailure: { code: 'network', retryable: true },
                responseBody: secret,
              },
            })
          ),
      });
      const failure = await rejected.then(
        () => new Error('expected operation rejection'),
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        'ACP fork operation failed; phase=fork_session; rpc_code=-32603; ' +
          'failure_type=api_error; task_failure=network; retryable=true'
      );
      expect(String(failure)).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds every session-list page and rejects unbounded unique cursors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    try {
      let pendingPageCalls = 0;
      const pendingConnection: Pick<acp.ClientSideConnection, 'listSessions'> = {
        listSessions: () => {
          pendingPageCalls += 1;
          return new Promise<acp.ListSessionsResponse>(() => undefined);
        },
      };
      const listing = listUntilParent(pendingConnection, '/workspace', 'parent', {
        deadlineAt: 2_020,
        maxPages: 3,
        reserveMs: 0,
      });
      const observed = Promise.race([
        listing.then(
          () => 'resolved' as const,
          () => 'rejected' as const
        ),
        new Promise<'still_pending'>((resolve) => {
          setTimeout(() => resolve('still_pending'), 25);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(25);
      expect(await observed).toBe('rejected');
      await expect(listing).rejects.toThrow(
        'ACP fork operation timed out; phase=list_sessions'
      );
      expect(pendingPageCalls).toBe(1);

      let uniquePageCalls = 0;
      const uniqueCursorConnection: Pick<acp.ClientSideConnection, 'listSessions'> = {
        listSessions: async () => {
          uniquePageCalls += 1;
          return { sessions: [], nextCursor: `cursor-${uniquePageCalls}` };
        },
      };
      await expect(
        listUntilParent(uniqueCursorConnection, '/workspace', 'parent', {
          deadlineAt: Date.now() + 1_000,
          maxPages: 3,
          reserveMs: 0,
        })
      ).rejects.toThrow('ACP session list exceeded 3 pages');
      expect(uniquePageCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shrinks notification waits to the shared deadline before registering', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    try {
      const client = new RecordingClient();
      const waitSpy = vi.spyOn(client, 'waitForNotification');
      const predicate: NotificationPredicate = () => false;
      const waiting = waitForAcpForkNotification({
        client,
        predicate,
        afterIndex: 0,
        phase: 'parent_commands_notification',
        deadlineAt: 3_035,
        maxMs: 10_000,
        reserveMs: 10,
      });
      const waitFailure = waiting.then(
        () => new Error('expected notification wait to time out'),
        (error: unknown) => error
      );
      expect(waitSpy).toHaveBeenCalledWith(predicate, {
        afterIndex: 0,
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(waitFailure).resolves.toMatchObject({
        message: 'ACP fork operation timed out; phase=parent_commands_notification',
      });
      client.close();

      const exhaustedClient = new RecordingClient();
      const exhaustedSpy = vi.spyOn(exhaustedClient, 'waitForNotification');
      await expect(
        waitForAcpForkNotification({
          client: exhaustedClient,
          predicate,
          phase: 'child_commands_notification',
          deadlineAt: Date.now() + 10,
          maxMs: 10_000,
          reserveMs: 10,
        })
      ).rejects.toThrow(
        'ACP fork operation has no remaining budget; ' +
          'phase=child_commands_notification'
      );
      expect(exhaustedSpy).not.toHaveBeenCalled();
      exhaustedClient.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks forced cleanup complete only after transport and destroy settle', async () => {
    let resolveDestroy: (() => void) | undefined;
    const destroy = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const harness = createPairedHarness(new RecordingClient(), {
      destroyAgent: () => destroy,
    });
    const forceClosing = harness.forceClose({ deadlineAt: Date.now() + 1_000 });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.cleanupCompleted()).toBe(false);
      resolveDestroy?.();
      await forceClosing;
      expect(harness.cleanupCompleted()).toBe(true);
      expect(harness.connection.signal.aborted).toBe(true);
    } finally {
      resolveDestroy?.();
      await forceClosing.catch(() => undefined);
    }
  });

  it('forces a graceful close that timed out while holding its writer lock', async () => {
    let releaseClose: (() => void) | undefined;
    let confirmWriterLocked: (() => void) | undefined;
    const writerLocked = new Promise<void>((resolve) => {
      confirmWriterLocked = resolve;
    });
    const blockedClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const harness = createPairedHarness(new RecordingClient(), {
      beforeWritableClose: async (phase) => {
        if (phase !== 'client_to_agent_close') return;
        confirmWriterLocked?.();
        await blockedClose;
      },
    });
    const trajectoryDeadlineAt = Date.now() + ACP_FORK_FORCE_CLOSE_RESERVE_MS + 25;
    const gracefulClose = harness.close({ deadlineAt: trajectoryDeadlineAt });
    const gracefulFailure = gracefulClose.then(
      () => new Error('expected graceful close to time out'),
      (error: unknown) => error
    );

    try {
      await writerLocked;
      await expect(gracefulFailure).resolves.toMatchObject({
        message: 'ACP fork graceful cleanup failed; phase=close',
      });
      expect(harness.cleanupCompleted()).toBe(false);

      await harness.forceClose({ deadlineAt: trajectoryDeadlineAt });
      expect(harness.cleanupCompleted()).toBe(true);

      releaseClose?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      releaseClose?.();
      await gracefulClose.catch(() => undefined);
      await harness
        .forceClose({ deadlineAt: Date.now() + 1_000 })
        .catch(() => undefined);
    }
  });

  it('retries forced cleanup after its first destroy deadline expires', async () => {
    let resolveDestroy: (() => void) | undefined;
    const destroy = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const harness = createPairedHarness(new RecordingClient(), {
      destroyAgent: () => destroy,
    });
    const firstForce = harness.forceClose({ deadlineAt: Date.now() + 20 });

    try {
      await expect(firstForce).rejects.toThrow('ACP fork cleanup exceeded');
      expect(harness.cleanupCompleted()).toBe(false);

      resolveDestroy?.();
      await harness.forceClose({ deadlineAt: Date.now() + 1_000 });
      expect(harness.cleanupCompleted()).toBe(true);
    } finally {
      resolveDestroy?.();
      await harness
        .forceClose({ deadlineAt: Date.now() + 1_000 })
        .catch(() => undefined);
    }
  });

  it('retries forced convergence after destroy rejects once', async () => {
    const secret = 'destroy-secret-must-not-appear';
    let destroyCalls = 0;
    const harness = createPairedHarness(new RecordingClient(), {
      destroyAgent: async () => {
        destroyCalls += 1;
        if (destroyCalls === 1) {
          throw new Error(`/private/${secret}`);
        }
      },
    });

    try {
      const firstFailure = await harness
        .forceClose({ deadlineAt: Date.now() + 1_000 })
        .then(
          () => new Error('expected first force close to fail'),
          (error: unknown) => error
        );
      expect(firstFailure).toBeInstanceOf(Error);
      expect((firstFailure as Error).message).toBe(
        'ACP fork cleanup failed; phase=agent_destroy'
      );
      expect((firstFailure as Error).cause).toBeUndefined();
      expect(String(firstFailure)).not.toContain(secret);
      expect(harness.cleanupCompleted()).toBe(false);

      await harness.forceClose({ deadlineAt: Date.now() + 1_000 });
      expect(harness.cleanupCompleted()).toBe(true);
      expect(destroyCalls).toBe(2);
    } finally {
      await harness
        .forceClose({ deadlineAt: Date.now() + 1_000 })
        .catch(() => undefined);
    }
  });

  it('reserves force-close time inside the trajectory cleanup budget', () => {
    expect(
      resolveAcpForkCleanupBudgets({
        deadlineAt: 30_000,
        now: 0,
        gracefulMaxMs: 20_000,
        forceReserveMs: 10_000,
      })
    ).toEqual({ gracefulMs: 20_000, forceMs: 10_000 });
    expect(
      resolveAcpForkCleanupBudgets({
        deadlineAt: 30_000,
        now: 15_000,
        gracefulMaxMs: 20_000,
        forceReserveMs: 10_000,
      })
    ).toEqual({ gracefulMs: 5_000, forceMs: 10_000 });
  });

  it('derives each prompt stage from one shared trajectory deadline', () => {
    expect(
      resolveAcpForkStageTimeout({
        deadlineAt: 1_340_000,
        maxStageMs: 270_000,
        now: 1_000_000,
      })
    ).toBe(270_000);
    expect(
      resolveAcpForkStageTimeout({
        deadlineAt: 1_340_000,
        maxStageMs: 270_000,
        now: 1_270_000,
      })
    ).toBe(70_000);
    expect(
      resolveAcpForkStageTimeout({
        deadlineAt: 1_340_000,
        maxStageMs: 270_000,
        now: 1_340_000,
      })
    ).toBe(0);
  });

  it('reserves cancellation and cleanup inside the shared fork deadline', () => {
    expect(
      resolveAcpForkPhaseBudgets({
        deadlineAt: 1_390_000,
        now: 1_000_000,
        maxStageMs: 270_000,
        cancelGraceMs: 15_000,
        cleanupReserveMs: 30_000,
      })
    ).toEqual({
      promptMs: 270_000,
      cancelMs: 15_000,
      cleanupMs: 30_000,
    });
    expect(
      resolveAcpForkPhaseBudgets({
        deadlineAt: 1_390_000,
        now: 1_330_000,
        maxStageMs: 270_000,
        cancelGraceMs: 15_000,
        cleanupReserveMs: 30_000,
      })
    ).toEqual({
      promptMs: 15_000,
      cancelMs: 15_000,
      cleanupMs: 30_000,
    });
    expect(
      resolveAcpForkPhaseBudgets({
        deadlineAt: 1_390_000,
        now: 1_375_000,
        maxStageMs: 270_000,
        cancelGraceMs: 15_000,
        cleanupReserveMs: 30_000,
      })
    ).toEqual({ promptMs: 0, cancelMs: 0, cleanupMs: 15_000 });
  });

  it('routes initialize through paired SDK streams and closes both connections', async () => {
    const harness = createPairedHarness();

    const initialized = await harness.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await harness.close();

    expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({
      list: {},
      fork: {},
      close: {},
    });
    expect(harness.connection.signal.aborted).toBe(true);
  });

  it('cancels and settles a prompt before reporting a stage deadline', async () => {
    let resolvePrompt: ((value: acp.PromptResponse) => void) | undefined;
    const prompt = new Promise<acp.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    const cancelledSessions: string[] = [];
    const harness: AcpPromptStageHarness = {
      connection: {
        prompt: () => prompt,
        cancel: async ({ sessionId }: { sessionId: string }) => {
          cancelledSessions.push(sessionId);
          resolvePrompt?.({ stopReason: 'cancelled' });
        },
      },
    };

    await expect(
      runPromptStage(harness, { sessionId: 'stage-timeout', prompt: [] }, 'parent', {
        timeoutMs: 5,
        cancelGraceMs: 50,
      })
    ).rejects.toThrow('ACP fork parent prompt exceeded 5ms');
    expect(cancelledSessions).toEqual(['stage-timeout']);
  });

  it('bounds a blocked cancel send inside the cancellation grace', async () => {
    const prompt = new Promise<acp.PromptResponse>(() => undefined);
    const cancel = new Promise<void>(() => undefined);
    const secretSessionId = 'secret-session-must-not-appear';
    const harness: AcpPromptStageHarness = {
      connection: {
        prompt: () => prompt,
        cancel: () => cancel,
      },
    };

    const startedAt = Date.now();
    const failure = await runPromptStage(
      harness,
      { sessionId: secretSessionId, prompt: [] },
      'parent',
      { timeoutMs: 5, cancelGraceMs: 20 }
    ).then(
      () => new Error('expected blocked cancel to fail'),
      (error: unknown) => error
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'ACP fork parent cancellation did not settle within 20ms'
    );
    expect(String(failure)).not.toContain(secretSessionId);
    expect((failure as Error).cause).toBeUndefined();
  });

  it('bounds cleanup phases without retaining raw failures', async () => {
    const secret = 'cleanup-secret-must-not-appear';
    const timeoutFailure = await runBoundedAcpForkCleanup(
      [
        {
          phase: 'agent_destroy',
          run: () => new Promise<void>(() => undefined),
        },
      ],
      20
    ).then(
      () => new Error('expected cleanup timeout'),
      (error: unknown) => error
    );
    expect(timeoutFailure).toBeInstanceOf(Error);
    expect((timeoutFailure as Error).message).toBe(
      'ACP fork cleanup exceeded 20ms; pending=agent_destroy'
    );
    expect((timeoutFailure as Error).cause).toBeUndefined();

    const rejection = await runBoundedAcpForkCleanup(
      [
        {
          phase: 'agent_destroy',
          run: () => Promise.reject(new Error(`/private/${secret}`)),
        },
      ],
      100
    ).then(
      () => new Error('expected cleanup rejection'),
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'ACP fork cleanup failed; phase=agent_destroy'
    );
    expect(String(rejection)).not.toContain(secret);
    expect((rejection as Error).cause).toBeUndefined();
  });

  it('bounds non-timeout prompt failures to stage and typed RPC metadata', () => {
    const secret = 'provider-secret-must-not-appear';
    const error = Object.assign(new Error(`upstream body ${secret}`), {
      code: -32603,
      data: {
        failureType: 'api_error',
        responseBody: secret,
      },
    });

    const diagnostic = describeAcpForkPromptFailure(error, 'child');

    expect(diagnostic).toBe(
      'ACP fork child prompt failed; rpc_code=-32603; failure_type=api_error; ' +
        'task_failure=unknown; retryable=unknown'
    );
    expect(diagnostic).not.toContain(secret);
  });

  it('does not retain the raw RPC failure as a printable cause', async () => {
    const harness = createPairedHarness();
    const secret = 'raw-provider-body-must-not-appear';
    const error = Object.assign(new Error('upstream body ' + secret), {
      code: -32603,
      data: { failureType: 'api_error', responseBody: secret },
    });
    vi.spyOn(harness.connection, 'prompt').mockRejectedValueOnce(error);

    try {
      const failure = await runPromptStage(
        harness,
        { sessionId: 'sanitized-stage-failure', prompt: [] },
        'parent'
      ).then(
        () => new Error('expected ACP prompt stage to fail'),
        (rejected: unknown) => rejected
      );
      if (!(failure instanceof Error)) {
        throw new Error('ACP prompt stage failure was not an Error');
      }
      expect(failure.message).toBe(
        'ACP fork parent prompt failed; rpc_code=-32603; failure_type=api_error; ' +
          'task_failure=unknown; retryable=unknown'
      );
      expect(failure.cause).toBeUndefined();
      expect(String(failure)).not.toContain(secret);
    } finally {
      await harness.close();
    }
  });

  it('resolves notification waiters from the matching incoming event', async () => {
    const client = new RecordingClient();
    const waiting = client.waitForNotification(
      (notification) =>
        notification.sessionId === 'child' &&
        notification.update.sessionUpdate === 'agent_message_chunk',
      { timeoutMs: 1_000 }
    );
    const update: acp.SessionNotification = {
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      },
    };

    await client.sessionUpdate(update);

    await expect(waiting).resolves.toBe(update);
    client.close();
  });

  it('resolves from a matching notification that arrived before the waiter', async () => {
    const client = new RecordingClient();
    const update: acp.SessionNotification = {
      sessionId: 'parent',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'yolo',
      },
    };
    await client.sessionUpdate(update);

    const waiting = client.waitForNotification(
      (notification) => notification.sessionId === 'parent',
      { timeoutMs: 100 }
    );

    await expect(waiting).resolves.toBe(update);
    client.close();
  });

  it('does not match notifications older than an explicit boundary', async () => {
    const client = new RecordingClient();
    await client.sessionUpdate({
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old' },
      },
    });
    const afterIndex = client.updates.length;
    const waiting = client.waitForNotification(
      (notification) =>
        notification.sessionId === 'child' &&
        notification.update.sessionUpdate === 'agent_message_chunk',
      { afterIndex, timeoutMs: 100 }
    );
    const fresh: acp.SessionNotification = {
      sessionId: 'child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fresh' },
      },
    };

    await client.sessionUpdate(fresh);

    await expect(waiting).resolves.toBe(fresh);
    client.close();
  });

  it('rejects pending notification waiters during teardown', async () => {
    const client = new RecordingClient();
    const waiting = client.waitForNotification(() => false, { timeoutMs: 1_000 });

    client.close();

    await expect(waiting).rejects.toThrow('recording client closed');
  });
});

describe('ACP parent trace diagnostics', () => {
  it('reports only structural metadata for a rejected Read trace', () => {
    const secretPath = '/private/tmp/secret-workspace/memory.txt';
    const secretOutput = 'must-not-appear';

    const metadata = describeParentTrace(
      [
        {
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { file_path: 'memory.txt', offset: 0 },
          output: secretOutput,
          error: null,
        },
      ],
      secretPath
    );

    expect(metadata).toEqual({
      traceLength: 1,
      records: [
        {
          toolName: 'Read',
          inputKeys: ['file_path', 'offset'],
          filePath: {
            basename: 'memory.txt',
            isAbsolute: false,
            equalsExpected: false,
          },
          outputType: 'string',
          outputNull: false,
          errorNull: true,
        },
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain(secretPath);
    expect(JSON.stringify(metadata)).not.toContain(secretOutput);
  });

  it('does not retain the rejected parent trace failure as a cause', () => {
    const secret = 'trace-cause-secret-must-not-appear';
    let failure: unknown;

    try {
      assertStrictParentTrace(
        [
          {
            toolCallId: 'tool-1',
            toolName: 'Write',
            input: { file_path: '/private/forbidden.txt' },
            output: null,
            error: secret,
          },
        ],
        '/workspace/memory.txt'
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(secret);
  });
});

describe('ACP fork notification window', () => {
  it('accepts empty and known-session synchronous fork windows', () => {
    expect(() =>
      assertKnownForkNotificationSessions([], 'parent', 'child')
    ).not.toThrow();
    expect(() =>
      assertKnownForkNotificationSessions(
        [
          {
            sessionId: 'parent',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'yolo',
            },
          },
          {
            sessionId: 'child',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'default',
            },
          },
        ],
        'parent',
        'child'
      )
    ).not.toThrow();
  });

  it('rejects a synchronous fork notification for a foreign session', () => {
    expect(() =>
      assertKnownForkNotificationSessions(
        [
          {
            sessionId: 'foreign',
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'default',
            },
          },
        ],
        'parent',
        'child'
      )
    ).toThrow('foreign session');
  });

  it('requires a non-empty post-fork window owned by the child', () => {
    expect(() => assertAllNotificationsForSession([], 'child')).toThrow(
      'must not be empty'
    );
    expect(() =>
      assertAllNotificationsForSession(
        [
          {
            sessionId: 'child',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        ],
        'child'
      )
    ).not.toThrow();
    expect(() =>
      assertAllNotificationsForSession(
        [
          {
            sessionId: 'parent',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
            },
          },
        ],
        'child'
      )
    ).toThrow('unexpected session');
  });
});

const enabled = isRealApiTestEnabled();
const modelConfigs = releaseBlockingModels(
  enabled ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true }) : []
);

function safeModelLabel(
  modelConfig: (typeof modelConfigs)[number],
  ordinal: number
): string {
  const family = modelConfig.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha256')
    .update(modelConfig.qualificationId)
    .digest('hex')
    .slice(0, 12);
  return `${family || 'model'}-${ordinal + 1}-${digest}`;
}

function createResolvedConfig(
  modelConfig: (typeof modelConfigs)[number]
): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
    allowedTools: ['Read'],
  };
}

function initializeIsolatedExtensions(
  fixture: ReturnType<typeof createForkFixture>
): void {
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
    '---\nname: skill-creator\ndescription: Local deterministic fixture.\n---\n\n# Fixture\n'
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

function isMessageOrToolNotification(notification: acp.SessionNotification): boolean {
  return [
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
  ].includes(notification.update.sessionUpdate);
}

function finalAgentText(notifications: readonly acp.SessionNotification[]): string {
  return notifications
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

function assertSafeFinal(text: string, marker: string, nonce: string): void {
  if (!text.trim()) throw new Error('ACP final response must be non-empty text');
  if (text.includes(marker) || text.includes(nonce)) {
    throw new Error('ACP final response exposed fixture material');
  }
}

async function listUntilParent(
  connection: Pick<acp.ClientSideConnection, 'listSessions'>,
  cwd: string,
  parentId: string,
  options: {
    deadlineAt: number;
    maxPages?: number;
    reserveMs?: number;
  }
): Promise<{
  parent: acp.SessionInfo;
  responses: acp.ListSessionsResponse[];
  sessions: Map<string, acp.SessionInfo>;
}> {
  const responses: acp.ListSessionsResponse[] = [];
  const sessions = new Map<string, acp.SessionInfo>();
  const seenCursors = new Set<string>();
  const maxPages = options.maxPages ?? ACP_FORK_LIST_MAX_PAGES;
  let cursor: string | undefined;

  while (true) {
    const response = await runAcpForkOperation({
      phase: 'list_sessions',
      deadlineAt: options.deadlineAt,
      maxMs: ACP_FORK_RPC_MAX_MS,
      reserveMs: options.reserveMs ?? ACP_FORK_CLEANUP_TIMEOUT_MS,
      run: () => connection.listSessions({ cwd, cursor }),
    });
    responses.push(response);
    for (const session of response.sessions) sessions.set(session.sessionId, session);
    const parent = sessions.get(parentId);
    if (parent) return { parent, responses, sessions };
    const nextCursor = response.nextCursor ?? undefined;
    if (!nextCursor) break;
    if (responses.length >= maxPages) {
      throw new Error(`ACP session list exceeded ${maxPages} pages`);
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('ACP session list returned a cursor cycle');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('ACP parent session was not returned by session/list');
}

const describeTrajectory = enabled ? describe.sequential : describe.skip;

describeTrajectory('ACP durable fork trajectory (real API)', () => {
  if (modelConfigs.length === 0) {
    it('requires REAL_API_TEST=1', () => undefined);
  }

  for (const [modelIndex, modelConfig] of modelConfigs.entries()) {
    const modelLabel = safeModelLabel(modelConfig, modelIndex);
    it(`${modelLabel} forks inherited Read evidence through paired SDK connections`, async () => {
      const trajectoryDeadlineAt = Date.now() + ACP_FORK_TRAJECTORY_BUDGET_MS;
      const fixture = createForkFixture('acp', modelLabel);
      const marker = `ACP_FORK_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const resultPath = path.join(fixture.workspace, 'result.txt');
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      let harness: PairedAcpHarness | undefined;
      let trajectoryFailed = false;
      let trajectoryFailure: unknown;
      let cleanupFailure: Error | undefined;

      assertNoSecrets({ marker, expectedBytes }, [modelConfig.apiKey]);

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        const runtimeConfig = createResolvedConfig(modelConfig);
        getState().config.actions.setConfig(runtimeConfig);
        writeFileSync(memoryPath, expectedBytes);

        await runWithCwdOverride(fixture.workspace, async () => {
          harness = createPairedHarness();
          const initialized = await runAcpForkOperation({
            phase: 'initialize',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_RPC_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
            run: () =>
              harness?.connection.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
              }) ?? Promise.reject(new Error('ACP harness unavailable')),
          });
          expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({
            list: {},
            fork: {},
            close: {},
          });

          const newSessionNotificationStart = harness.client.updates.length;
          const created = await runAcpForkOperation({
            phase: 'new_session',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_RPC_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
            run: () =>
              harness?.connection.newSession({
                cwd: fixture.workspace,
                mcpServers: [],
              }) ?? Promise.reject(new Error('ACP harness unavailable')),
          });
          expect(created).toMatchObject({
            modes: {
              currentModeId: 'default',
              availableModes: expect.arrayContaining([
                expect.objectContaining({ id: 'yolo' }),
              ]),
            },
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                type: 'select',
                id: 'model',
                category: 'model',
                currentValue: runtimeConfig.currentModelId,
                options: expect.arrayContaining([
                  expect.objectContaining({
                    value: runtimeConfig.currentModelId,
                  }),
                ]),
              }),
            ]),
          });
          const parentId = created.sessionId;
          const parentCommands = await waitForAcpForkNotification({
            client: harness.client,
            predicate: (notification) =>
              notification.sessionId === parentId &&
              notification.update.sessionUpdate === 'available_commands_update',
            afterIndex: newSessionNotificationStart,
            phase: 'parent_commands_notification',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_NOTIFICATION_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
          });
          expect(parentCommands.sessionId).toBe(parentId);
          const parentNotificationStart = harness.client.updates.length;
          await runAcpForkOperation({
            phase: 'parent_set_mode',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_RPC_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
            run: () =>
              harness?.connection.setSessionMode({
                sessionId: parentId,
                modeId: 'yolo',
              }) ?? Promise.reject(new Error('ACP harness unavailable')),
          });
          const parentPrompt = await runPromptStage(
            harness,
            {
              sessionId: parentId,
              prompt: [
                {
                  type: 'text',
                  text: [
                    `Use Read on the workspace file at the exact absolute path ${memoryPath}.`,
                    'Remember its complete contents for a later fork.',
                    'Do not repeat, quote, encode, or summarize the file contents in final prose.',
                    'After the successful Read, give a brief completion confirmation.',
                  ].join(' '),
                },
              ],
            },
            'parent',
            { deadlineAt: trajectoryDeadlineAt }
          );
          expect(parentPrompt.stopReason).toBe('end_turn');
          const parentNotifications = harness.client.updates.slice(
            parentNotificationStart
          );
          expect(
            parentNotifications.every(
              (notification) => notification.sessionId === parentId
            )
          ).toBe(true);
          assertSafeFinal(finalAgentText(parentNotifications), marker, fixture.nonce);

          const parentPath = findSessionTranscript(fixture.storageRoot, parentId);
          const parentEvents = readSessionEvents(parentPath);
          assertStrictParentTrace(extractDurableToolTrace(parentEvents), memoryPath);
          const parentSnapshot = readFileSync(parentPath);

          const listed = await listUntilParent(
            harness.connection,
            fixture.workspace,
            parentId,
            { deadlineAt: trajectoryDeadlineAt }
          );
          expect(listed.sessions.size).toBe(1);
          expect(listed.parent).toMatchObject({
            sessionId: parentId,
            cwd: fixture.workspace,
            title: expect.stringContaining('Use Read'),
          });
          expect(typeof listed.parent.updatedAt).toBe('string');
          expect(Number.isNaN(Date.parse(listed.parent.updatedAt ?? ''))).toBe(false);

          getState().config.actions.updateConfig({
            allowedTools: ['Write', 'Bash'],
          });
          const forkNotificationStart = harness.client.updates.length;
          const forked = await runAcpForkOperation({
            phase: 'fork_session',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_RPC_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
            run: () =>
              harness?.connection.unstable_forkSession({
                sessionId: parentId,
                cwd: fixture.workspace,
                mcpServers: [],
              }) ?? Promise.reject(new Error('ACP harness unavailable')),
          });
          const forkNotifications = harness.client.updates.slice(forkNotificationStart);
          assertKnownForkNotificationSessions(
            forkNotifications,
            parentId,
            forked.sessionId
          );
          expect(
            forkNotifications.filter(
              (notification) =>
                notification.sessionId === forked.sessionId &&
                (notification.update.sessionUpdate === 'user_message_chunk' ||
                  notification.update.sessionUpdate === 'agent_message_chunk')
            )
          ).toEqual([]);
          const { sessionId: _parentId, ...newSetup } = created;
          const { sessionId: childId, ...forkSetup } = forked;
          expect(childId).not.toBe(parentId);
          expect(forkSetup).toMatchObject({
            ...newSetup,
            modes: {
              ...newSetup.modes,
              currentModeId: 'yolo',
            },
          });
          expect(forkSetup._meta).toMatchObject({
            'blade/taskIsolation': 'local',
            'blade/taskSourceProjectPath': fixture.workspace,
            'blade/taskProjectPath': fixture.workspace,
          });

          getState().config.actions.updateConfig({
            allowedTools: ['Write', 'Bash'],
          });
          await runAcpForkOperation({
            phase: 'child_set_mode',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_RPC_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
            run: () =>
              harness?.connection.setSessionMode({
                sessionId: childId,
                modeId: 'yolo',
              }) ?? Promise.reject(new Error('ACP harness unavailable')),
          });
          const childPath = findSessionTranscript(fixture.storageRoot, childId);
          const childSnapshot = readSessionEvents(childPath);
          rmSync(memoryPath);
          expect(existsSync(memoryPath)).toBe(false);

          const childNotificationStart = harness.client.updates.length;
          const childPrompt = await runPromptStage(
            harness,
            {
              sessionId: childId,
              prompt: [
                {
                  type: 'text',
                  text: [
                    'Recover the complete marker from the inherited Read result.',
                    'Call Write exactly once total.',
                    `That call must set file_path to the exact absolute path ${resultPath}.`,
                    'Never call Write with a relative path, any other path, or retry Write.',
                    'Write the inherited bytes exactly with one trailing newline.',
                    'After the successful Write, call Bash exactly once with `wc -c result.txt`.',
                    'Use no other tools or commands, never repeat the marker in final prose, and briefly confirm completion.',
                  ].join(' '),
                },
              ],
            },
            'child',
            { deadlineAt: trajectoryDeadlineAt }
          );
          expect(childPrompt.stopReason).toBe('end_turn');
          const childNotifications =
            harness.client.updates.slice(childNotificationStart);
          expect(
            childNotifications
              .filter(isMessageOrToolNotification)
              .every((notification) => notification.sessionId === childId)
          ).toBe(true);
          const writeStarts = childNotifications.flatMap((notification) =>
            notification.update.sessionUpdate === 'tool_call' &&
            notification.update.title === 'Executing Write'
              ? [{ notification, update: notification.update }]
              : []
          );
          expect(writeStarts).toHaveLength(1);
          const writeToolCallId = writeStarts[0]?.update.toolCallId;
          const writeTerminals = childNotifications.flatMap((notification) =>
            notification.update.sessionUpdate === 'tool_call_update' &&
            notification.update.toolCallId === writeToolCallId &&
            (notification.update.status === 'completed' ||
              notification.update.status === 'failed')
              ? [{ notification, update: notification.update }]
              : []
          );
          expect(writeTerminals).toEqual([
            expect.objectContaining({
              notification: expect.objectContaining({ sessionId: childId }),
              update: expect.objectContaining({
                sessionUpdate: 'tool_call_update',
                toolCallId: writeToolCallId,
                status: 'completed',
              }),
            }),
          ]);
          assertSafeFinal(finalAgentText(childNotifications), marker, fixture.nonce);
          expect(readFileSync(resultPath, 'utf8')).toBe(expectedBytes);
          const childCommands = await waitForAcpForkNotification({
            client: harness.client,
            predicate: (notification) =>
              notification.sessionId === childId &&
              notification.update.sessionUpdate === 'available_commands_update',
            afterIndex: forkNotificationStart,
            phase: 'child_commands_notification',
            deadlineAt: trajectoryDeadlineAt,
            maxMs: ACP_FORK_NOTIFICATION_MAX_MS,
            reserveMs: ACP_FORK_CLEANUP_TIMEOUT_MS,
          });
          expect(childCommands.sessionId).toBe(childId);
          const postForkNotifications =
            harness.client.updates.slice(forkNotificationStart);
          assertAllNotificationsForSession(postForkNotifications, childId);

          const childEvents = readSessionEvents(childPath);
          const childRaw = readFileSync(childPath);
          assertForkChildToolTrace(
            extractDurableToolTrace(childEvents, {
              afterEventCount: childSnapshot.length,
            }),
            resultPath,
            expectedBytes
          );
          assertForkLineage(childEvents, {
            childId,
            parentId,
            rootId: parentId,
          });
          expect(childEvents.length).toBeGreaterThan(childSnapshot.length);
          const parentEventIds = new Set(parentEvents.map((event) => event.id));
          expect(childEvents.every((event) => !parentEventIds.has(event.id))).toBe(
            true
          );
          expect(readFileSync(parentPath).equals(parentSnapshot)).toBe(true);
          expect(existsSync(fixture.resultPath)).toBe(false);

          assertNoSecrets(
            {
              initialized,
              created,
              listResponses: listed.responses,
              forked,
              parentPrompt,
              childPrompt,
              notifications: harness.client.updates,
              parentSnapshot,
              childRaw,
              resultBytes: readFileSync(resultPath),
            },
            [modelConfig.apiKey]
          );

          await harness.close({ deadlineAt: trajectoryDeadlineAt });
          harness = undefined;
        });
      } catch (error) {
        trajectoryFailed = true;
        trajectoryFailure = error;
      } finally {
        await runWithCwdOverride(fixture.workspace, async () => {
          if (harness && !harness.cleanupCompleted()) {
            await harness.close({ deadlineAt: trajectoryDeadlineAt }).catch(() => {
              cleanupFailure = new Error(
                'ACP fork cleanup failed; phase=graceful_close'
              );
            });
          }
          if (harness && !harness.cleanupCompleted()) {
            await harness.forceClose({ deadlineAt: trajectoryDeadlineAt }).catch(() => {
              cleanupFailure = new Error('ACP fork cleanup failed; phase=force_close');
            });
          }
        });
        const cleanupCompleted = harness?.cleanupCompleted() ?? true;
        if (cleanupCompleted) cleanupFailure = undefined;
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        if (cleanupCompleted) cleanupForkFixture(fixture);
      }
      if (trajectoryFailed) {
        if (cleanupFailure) console.error(cleanupFailure.message);
        throw trajectoryFailure;
      }
      if (cleanupFailure) throw cleanupFailure;
    }, 420_000);
  }
});
