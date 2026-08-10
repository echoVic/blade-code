import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { McpInteractionContext } from './McpClient.js';
import { McpClient } from './McpClient.js';
import {
  isMcpTaskTerminal,
  MAX_MCP_TASKS_GLOBAL,
  type McpServerTaskState,
  type McpTaskChange,
  type McpTaskOwner,
  type McpTaskSnapshot,
  normalizeMcpTaskTtl,
  sanitizeMcpTaskError,
} from './McpTasks.js';

interface McpTaskRecord {
  taskId: string;
  serverName: string;
  toolName: string;
  owner: McpTaskOwner;
  client: McpClient;
  serverTaskId: string;
  serverCreatedAt: string;
  status: McpTaskSnapshot['status'];
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  hasResult: boolean;
  result?: McpTaskSnapshot['result'];
  error?: string;
  pollIntervalMs: number;
  deadline: number;
  controller: AbortController;
  promise?: Promise<void>;
}

export interface StartMcpTaskInput {
  client: McpClient;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  owner: McpTaskOwner;
  interactionContext: McpInteractionContext;
  signal?: AbortSignal;
  ttlMs?: number;
}

export class McpTaskManager extends EventEmitter {
  private static instance: McpTaskManager | undefined;
  private readonly tasks = new Map<string, McpTaskRecord>();
  private revision = 0;

  static getInstance(): McpTaskManager {
    if (!McpTaskManager.instance) {
      McpTaskManager.instance = new McpTaskManager();
    }
    return McpTaskManager.instance;
  }

  static resetForTests(): void {
    McpTaskManager.instance?.removeAllListeners();
    McpTaskManager.instance = undefined;
  }

  async start(input: StartMcpTaskInput): Promise<McpTaskSnapshot> {
    const owner = normalizeOwner(input.owner);
    const policy = input.client.tasks;
    if (!policy.enabled) {
      throw new Error(`MCP tasks are disabled for server "${input.serverName}"`);
    }
    this.evictTerminalTasks(owner, policy.maxTasksPerSession);
    const ownerTaskCount = this.list(owner).length;
    if (ownerTaskCount >= policy.maxTasksPerSession) {
      throw new Error(
        `MCP task limit reached for Session (${policy.maxTasksPerSession})`
      );
    }
    if (this.tasks.size >= MAX_MCP_TASKS_GLOBAL) {
      throw new Error(`Global MCP task limit reached (${MAX_MCP_TASKS_GLOBAL})`);
    }

    const ttlMs = normalizeMcpTaskTtl(input.ttlMs, policy);
    const controller = new AbortController();
    const abortCreation = () =>
      controller.abort(input.signal?.reason ?? 'MCP task creation cancelled');
    input.signal?.addEventListener('abort', abortCreation, { once: true });
    let created: McpServerTaskState;
    try {
      created = await input.client.createToolTask(
        input.toolName,
        input.arguments,
        input.interactionContext,
        controller.signal,
        ttlMs
      );
    } finally {
      input.signal?.removeEventListener('abort', abortCreation);
    }

    const now = Date.now();
    const taskId = `mcp_task_${randomUUID()}`;
    const record: McpTaskRecord = {
      taskId,
      serverName: input.serverName,
      toolName: input.toolName,
      owner,
      client: input.client,
      serverTaskId: created.taskId,
      serverCreatedAt: created.createdAt,
      status: created.status,
      statusMessage: created.statusMessage,
      createdAt: now,
      updatedAt: now,
      hasResult: false,
      pollIntervalMs: created.pollIntervalMs,
      deadline: now + Math.min(ttlMs, policy.maxLifetimeMs),
      controller,
    };
    this.tasks.set(taskId, record);
    this.publish(record);
    record.promise = this.poll(record);
    void record.promise.catch(() => undefined);
    return this.snapshot(record);
  }

  get(taskId: string, owner: McpTaskOwner): McpTaskSnapshot | undefined {
    const record = this.getOwnedRecord(taskId, owner);
    return record ? this.snapshot(record) : undefined;
  }

  list(owner: McpTaskOwner, serverName?: string): McpTaskSnapshot[] {
    const normalizedOwner = normalizeOwner(owner);
    return [...this.tasks.values()]
      .filter(
        (record) =>
          sameOwner(record.owner, normalizedOwner) &&
          (!serverName || record.serverName === serverName)
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.snapshot(record));
  }

  async wait(
    taskId: string,
    owner: McpTaskOwner,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<McpTaskSnapshot | undefined> {
    const record = this.getOwnedRecord(taskId, owner);
    if (!record) return undefined;
    if (!record.promise || isMcpTaskTerminal(record.status)) {
      return this.snapshot(record);
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
      timer.unref();
      if (signal) {
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) resolve();
      }
    });
    await Promise.race([record.promise, boundary]);
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    return this.snapshot(record);
  }

  async cancel(
    taskId: string,
    owner: McpTaskOwner,
    signal?: AbortSignal
  ): Promise<McpTaskSnapshot | undefined> {
    const record = this.getOwnedRecord(taskId, owner);
    if (!record) return undefined;
    if (isMcpTaskTerminal(record.status)) return this.snapshot(record);
    let cancellationError: string | undefined;
    try {
      await record.client.cancelToolTask(record.serverTaskId, signal);
    } catch (error) {
      cancellationError = sanitizeTaskError(error, record.serverTaskId);
    }
    record.controller.abort('MCP task cancelled');
    this.update(record, {
      status: 'cancelled',
      statusMessage: cancellationError
        ? `Local cancellation completed; server acknowledgement failed: ${cancellationError}`
        : 'Task cancelled',
      completedAt: Date.now(),
    });
    record.client.releaseTaskInteraction(record.serverTaskId);
    return this.snapshot(record);
  }

  async cancelSession(owner: McpTaskOwner): Promise<void> {
    const records = this.ownedRecords(owner);
    await Promise.all(
      records
        .filter((record) => !isMcpTaskTerminal(record.status))
        .map((record) => this.cancel(record.taskId, owner))
    );
    await Promise.allSettled(
      records
        .map((record) => record.promise)
        .filter((promise): promise is Promise<void> => promise !== undefined)
    );
    for (const record of records) {
      record.client.releaseTaskInteraction(record.serverTaskId);
      this.tasks.delete(record.taskId);
    }
  }

  async cancelClient(client: McpClient): Promise<void> {
    const records = [...this.tasks.values()].filter(
      (record) => record.client === client && !isMcpTaskTerminal(record.status)
    );
    await Promise.all(
      records.map((record) => this.cancel(record.taskId, record.owner))
    );
  }

  private async poll(record: McpTaskRecord): Promise<void> {
    try {
      while (!record.controller.signal.aborted) {
        const remaining = record.deadline - Date.now();
        if (remaining <= 0) {
          await this.cancel(record.taskId, record.owner);
          if (record.status === 'cancelled') {
            this.update(record, {
              status: 'failed',
              statusMessage: 'MCP task exceeded its local lifetime budget',
              error: 'MCP task timed out',
              completedAt: Date.now(),
            });
          }
          return;
        }

        let state: McpServerTaskState;
        try {
          state = await record.client.getToolTask(
            record.serverTaskId,
            record.serverCreatedAt,
            record.controller.signal
          );
        } catch (error) {
          if (record.controller.signal.aborted) return;
          if (record.client.connectionStatus === 'connected') throw error;
          this.update(record, {
            status: 'interrupted',
            statusMessage: 'Waiting for MCP connection recovery',
          });
          await record.client.waitUntilConnected(record.controller.signal, remaining);
          continue;
        }

        this.applyServerState(record, state);
        if (state.status === 'completed' || state.status === 'input_required') {
          const resultWaitMs = record.deadline - Date.now();
          if (resultWaitMs <= 0) continue;
          let raw: Awaited<ReturnType<McpClient['getToolTaskResult']>>;
          try {
            raw = await record.client.getToolTaskResult(
              record.serverTaskId,
              record.controller.signal,
              resultWaitMs
            );
          } catch (error) {
            if (record.controller.signal.aborted) return;
            if (record.client.connectionStatus === 'connected') throw error;
            this.update(record, {
              status: 'interrupted',
              statusMessage: 'Waiting for MCP connection recovery',
            });
            await record.client.waitUntilConnected(
              record.controller.signal,
              resultWaitMs
            );
            continue;
          }
          const normalized = await record.client.normalizeToolTaskResult(raw);
          const redactedLlmContent = normalized.llmContent.replaceAll(
            record.serverTaskId,
            '[redacted-task-id]'
          );
          const projectedResult = normalized.isError
            ? {
                ...normalized,
                llmContent: sanitizeTaskError(redactedLlmContent, record.serverTaskId),
              }
            : {
                ...normalized,
                llmContent: redactedLlmContent,
              };
          this.update(record, {
            status: normalized.isError ? 'failed' : 'completed',
            hasResult: true,
            result: projectedResult,
            ...(normalized.isError
              ? {
                  error: projectedResult.llmContent,
                  statusMessage: 'MCP task returned an error result',
                }
              : {}),
            completedAt: Date.now(),
          });
          return;
        }
        if (state.status === 'failed' || state.status === 'cancelled') {
          this.update(record, {
            status: state.status,
            error:
              state.status === 'failed'
                ? (state.statusMessage ?? 'MCP task failed')
                : undefined,
            completedAt: Date.now(),
          });
          return;
        }

        await wait(record.pollIntervalMs, record.controller.signal);
      }
    } catch (error) {
      if (!record.controller.signal.aborted) {
        this.update(record, {
          status: 'failed',
          statusMessage: 'MCP task lifecycle failed',
          error: sanitizeTaskError(error, record.serverTaskId),
          completedAt: Date.now(),
        });
      }
    } finally {
      record.client.releaseTaskInteraction(record.serverTaskId);
    }
  }

  private applyServerState(record: McpTaskRecord, state: McpServerTaskState): void {
    record.pollIntervalMs = state.pollIntervalMs;
    this.update(record, {
      status: state.status,
      statusMessage: state.statusMessage,
    });
  }

  private update(
    record: McpTaskRecord,
    values: Partial<
      Pick<
        McpTaskRecord,
        'status' | 'statusMessage' | 'completedAt' | 'hasResult' | 'result' | 'error'
      >
    >
  ): void {
    const before = JSON.stringify({
      status: record.status,
      statusMessage: record.statusMessage,
      hasResult: record.hasResult,
      error: record.error,
    });
    Object.assign(record, values, { updatedAt: Date.now() });
    const after = JSON.stringify({
      status: record.status,
      statusMessage: record.statusMessage,
      hasResult: record.hasResult,
      error: record.error,
    });
    if (before !== after || values.completedAt !== undefined) {
      this.publish(record);
    }
  }

  private publish(record: McpTaskRecord): void {
    const change: McpTaskChange = {
      revision: ++this.revision,
      owner: { ...record.owner },
      ...this.snapshot(record),
    };
    this.emit('taskChanged', change);
  }

  private snapshot(record: McpTaskRecord): McpTaskSnapshot {
    return structuredClone({
      taskId: record.taskId,
      serverName: record.serverName,
      toolName: record.toolName,
      status: record.status,
      ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      hasResult: record.hasResult,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    });
  }

  private getOwnedRecord(
    taskId: string,
    owner: McpTaskOwner
  ): McpTaskRecord | undefined {
    const record = this.tasks.get(taskId);
    return record && sameOwner(record.owner, normalizeOwner(owner))
      ? record
      : undefined;
  }

  private ownedRecords(owner: McpTaskOwner): McpTaskRecord[] {
    const normalizedOwner = normalizeOwner(owner);
    return [...this.tasks.values()].filter((record) =>
      sameOwner(record.owner, normalizedOwner)
    );
  }

  private evictTerminalTasks(owner: McpTaskOwner, maxTasksPerSession: number): void {
    const terminal = this.ownedRecords(owner)
      .filter((record) => isMcpTaskTerminal(record.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.list(owner).length >= maxTasksPerSession && terminal.length > 0) {
      const record = terminal.shift();
      if (record) this.tasks.delete(record.taskId);
    }
    if (this.tasks.size >= MAX_MCP_TASKS_GLOBAL) {
      const globalTerminal = [...this.tasks.values()]
        .filter((record) => isMcpTaskTerminal(record.status))
        .sort((left, right) => left.updatedAt - right.updatedAt);
      while (this.tasks.size >= MAX_MCP_TASKS_GLOBAL && globalTerminal.length > 0) {
        const record = globalTerminal.shift();
        if (record) this.tasks.delete(record.taskId);
      }
    }
  }
}

function normalizeOwner(owner: McpTaskOwner): McpTaskOwner {
  if (!owner.sessionId) throw new Error('MCP task owner requires a Session ID');
  return {
    sessionId: owner.sessionId,
    projectPath: path.resolve(owner.projectPath),
  };
}

function sameOwner(left: McpTaskOwner, right: McpTaskOwner): boolean {
  return left.sessionId === right.sessionId && left.projectPath === right.projectPath;
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(
        new DOMException(String(signal.reason || 'MCP task cancelled'), 'AbortError')
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function sanitizeTaskError(error: unknown, serverTaskId: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeMcpTaskError(message.replaceAll(serverTaskId, '[redacted-task-id]'));
}
