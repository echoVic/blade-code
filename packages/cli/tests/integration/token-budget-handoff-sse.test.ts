import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenBudgetHandoffRecordedV1 } from '../../src/context/TokenBudgetHandoff.js';
import { SessionEventLog } from '../../src/context/events/SessionEventLog.js';
import { JSONLStore } from '../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../src/context/storage/pathUtils.js';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../src/context/types.js';
import { Bus } from '../../src/server/bus.js';
import { EventRoutes } from '../../src/server/routes/events.js';
import {
  createSessionRouteController,
  type SessionRouteController,
} from '../../src/server/routes/session.js';

interface SseFrame {
  id?: string;
  data: string;
}

interface SessionFeedPayload {
  type: string;
  seq?: number;
  properties?: {
    event?: SessionEvent;
    sessionId?: string;
    projectPath?: string;
    taskStatus?: string;
  };
}

interface GlobalFeedPayload {
  type: string;
  properties?: {
    sessionId?: string;
    projectPath?: string;
    taskStatus?: string;
  };
}

interface SessionCommittedIdentity {
  type: string;
  seq: number | undefined;
  messageId?: string;
}

type StreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>;

class BoundedSseReader {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly timeoutMs: number
  ) {}

  async nextFrame(): Promise<SseFrame> {
    const deadline = Date.now() + this.timeoutMs;

    while (true) {
      const delimiterIndex = this.buffer.indexOf('\n\n');
      if (delimiterIndex >= 0) {
        const raw = this.buffer.slice(0, delimiterIndex);
        this.buffer = this.buffer.slice(delimiterIndex + 2);
        const frame = parseSseFrame(raw);
        if (frame) return frame;
        continue;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Timed out waiting for SSE frame after ${this.timeoutMs}ms`);
      }

      const result = await this.readWithTimeout(remainingMs);
      if (result.done) {
        throw new Error('SSE stream ended before the next frame');
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }

  private async readWithTimeout(remainingMs: number): Promise<StreamReadResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(`Timed out waiting for SSE bytes after ${this.timeoutMs}ms`)
            );
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

function parseSseFrame(raw: string): SseFrame | undefined {
  const dataLines: string[] = [];
  let id: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      id = line.slice(3).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return undefined;
  return { ...(id !== undefined ? { id } : {}), data: dataLines.join('\n') };
}

function messageCreated(
  sessionId: string,
  projectPath: string,
  id: string,
  timestamp: string
): SessionEvent {
  return {
    id,
    sessionId,
    projectPath,
    timestamp,
    type: 'message_created',
    cwd: projectPath,
    version: 'test',
    data: { messageId: id, role: 'assistant', createdAt: timestamp },
  };
}

function tokenBudgetHandoffRecorded(
  sessionId: string,
  projectPath: string,
  id: string
): TokenBudgetHandoffRecordedEvent {
  const data = {
    version: 1,
    messageId: 'handoff-message-1',
    observedPromptTokens: 75,
    availableForInput: 100,
    handoffThreshold: 70,
    compactionThreshold: 80,
    createdAt: '2026-08-19T08:00:00.000Z',
  } satisfies TokenBudgetHandoffRecordedV1;

  return {
    id,
    sessionId,
    projectPath,
    timestamp: '2026-08-19T08:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: projectPath,
    version: 'test',
    data,
  };
}

function eventMessageId(event: SessionEvent | undefined): string | undefined {
  return event?.type === 'message_created' ? event.data.messageId : undefined;
}

function committedIdentity(payload: SessionFeedPayload): SessionCommittedIdentity {
  return {
    type: payload.type,
    seq: payload.seq,
    ...(payload.type === 'committed.message_created'
      ? { messageId: eventMessageId(payload.properties?.event) }
      : {}),
  };
}

async function openSessionFeed(
  controller: SessionRouteController,
  sessionId: string,
  projectPath: string,
  lastEventId: number
): Promise<{
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  frames: BoundedSseReader;
}> {
  const abort = new AbortController();
  const response = await controller.app.request(
    `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
    {
      headers: { 'Last-Event-ID': String(lastEventId) },
      signal: abort.signal,
    }
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected session SSE response body');
  return {
    abort,
    reader,
    frames: new BoundedSseReader(reader, 5000),
  };
}

async function openGlobalFeed(): Promise<{
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  frames: BoundedSseReader;
}> {
  const abort = new AbortController();
  const response = await EventRoutes().request('/', { signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected global SSE response body');
  return {
    abort,
    reader,
    frames: new BoundedSseReader(reader, 5000),
  };
}

describe('token-budget handoff SSE suppression', () => {
  let tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((root) => rm(root, { recursive: true, force: true }))
    );
    tempRoots = [];
  });

  it('keeps session event SSE limited to visible committed events across the replay-live cutover', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-handoff-session-sse-'));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const sessionId = 'handoff-session-feed';
    const persistent = new PersistentStore(workspace, 100, 'test');
    const controller = createSessionRouteController();
    const log = SessionEventLog.for(sessionId, workspace);
    let feed:
      | {
          abort: AbortController;
          reader: ReadableStreamDefaultReader<Uint8Array>;
          frames: BoundedSseReader;
        }
      | undefined;

    try {
      await persistent.initSession(sessionId);
      const filePath = getSessionFilePath(workspace, sessionId);
      await log.commit(
        messageCreated(
          sessionId,
          workspace,
          'replay-visible-a',
          '2026-08-19T08:00:01.000Z'
        )
      );
      await log.commit(
        tokenBudgetHandoffRecorded(sessionId, workspace, 'replay-handoff-record-1')
      );
      await log.commit(
        messageCreated(
          sessionId,
          workspace,
          'replay-visible-b',
          '2026-08-19T08:00:02.000Z'
        )
      );

      feed = await openSessionFeed(controller, sessionId, workspace, 0);
      const connected = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;
      expect(connected.type).toBe('connected');

      const replayedCreated = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;
      const replayedVisibleA = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;
      const replayedVisibleB = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;

      const replayPayloads = [replayedCreated, replayedVisibleA, replayedVisibleB];
      expect(replayPayloads.map((payload) => payload.type)).toEqual([
        'committed.session_created',
        'committed.message_created',
        'committed.message_created',
      ]);
      expect(replayPayloads.map((payload) => payload.seq)).toEqual([1, 2, 4]);
      expect(committedIdentity(replayedCreated)).toEqual({
        type: 'committed.session_created',
        seq: 1,
      });
      expect(committedIdentity(replayedVisibleA)).toEqual({
        type: 'committed.message_created',
        seq: 2,
        messageId: 'replay-visible-a',
      });
      expect(committedIdentity(replayedVisibleB)).toEqual({
        type: 'committed.message_created',
        seq: 4,
        messageId: 'replay-visible-b',
      });

      await log.commit(
        messageCreated(
          sessionId,
          workspace,
          'live-visible-c',
          '2026-08-19T08:00:03.000Z'
        )
      );
      await log.commit(
        tokenBudgetHandoffRecorded(sessionId, workspace, 'live-handoff-record-2')
      );
      await log.commit(
        messageCreated(
          sessionId,
          workspace,
          'live-visible-d',
          '2026-08-19T08:00:04.000Z'
        )
      );

      const liveVisibleC = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;
      const liveVisibleD = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as SessionFeedPayload;
      const livePayloads = [liveVisibleC, liveVisibleD];

      expect(livePayloads.map((payload) => payload.type)).toEqual([
        'committed.message_created',
        'committed.message_created',
      ]);
      expect(livePayloads.map((payload) => payload.seq)).toEqual([5, 7]);
      expect(committedIdentity(liveVisibleC)).toEqual({
        type: 'committed.message_created',
        seq: 5,
        messageId: 'live-visible-c',
      });
      expect(committedIdentity(liveVisibleD)).toEqual({
        type: 'committed.message_created',
        seq: 7,
        messageId: 'live-visible-d',
      });

      const payloads = [...replayPayloads, ...livePayloads];
      expect(payloads.map((payload) => payload.seq)).toEqual([1, 2, 4, 5, 7]);

      const transcript = await new JSONLStore(filePath).readAll();
      expect(transcript.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(transcript.map((event) => event.type)).toEqual([
        'session_created',
        'message_created',
        'token_budget_handoff_recorded',
        'message_created',
        'message_created',
        'token_budget_handoff_recorded',
        'message_created',
      ]);

      const serializedFeed = payloads
        .map((payload) => JSON.stringify(payload))
        .join('\n');
      expect(serializedFeed).not.toContain('token_budget_handoff_recorded');
      expect(serializedFeed).not.toContain('handoff-message-1');
      expect(serializedFeed).not.toContain('Context rollover is approaching');
    } finally {
      feed?.abort.abort();
      await feed?.reader.cancel().catch(() => undefined);
      await controller.shutdown('test-cleanup');
      SessionEventLog.release(sessionId, workspace);
      if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
  });

  it('keeps global SSE free of handoff payloads before the next supported task sentinel', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-handoff-global-sse-'));
    tempRoots.push(root);
    const workspace = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const sessionId = 'handoff-global-feed';
    const persistent = new PersistentStore(workspace, 100, 'test');
    const log = SessionEventLog.for(sessionId, workspace);
    let feed:
      | {
          abort: AbortController;
          reader: ReadableStreamDefaultReader<Uint8Array>;
          frames: BoundedSseReader;
        }
      | undefined;

    try {
      await persistent.initSession(sessionId);
      feed = await openGlobalFeed();
      const connected = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as GlobalFeedPayload;
      expect(connected.type).toBe('connected');

      await log.commit(
        tokenBudgetHandoffRecorded(sessionId, workspace, 'handoff-record-2')
      );
      await nextImmediate();
      Bus.publish({ sessionId, projectPath: workspace }, 'task.status', {
        taskStatus: 'completed',
        updatedAt: '2026-08-19T08:00:03.000Z',
        taskQueueDepth: 0,
        taskConcurrencyLimit: 1,
        taskInFlight: 0,
      });

      const sentinel = JSON.parse(
        (await feed.frames.nextFrame()).data
      ) as GlobalFeedPayload;
      expect(sentinel).toMatchObject({
        type: 'task.status',
        properties: {
          sessionId,
          projectPath: workspace,
          taskStatus: 'completed',
        },
      });

      const serializedSentinel = JSON.stringify(sentinel);
      expect(serializedSentinel).not.toContain('token_budget_handoff_recorded');
      expect(serializedSentinel).not.toContain('handoff-message-1');
      expect(serializedSentinel).not.toContain('Context rollover is approaching');
    } finally {
      feed?.abort.abort();
      await feed?.reader.cancel().catch(() => undefined);
      SessionEventLog.release(sessionId, workspace);
      if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
  });
});
