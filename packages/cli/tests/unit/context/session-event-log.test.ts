import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EphemeralDelta } from '../../../src/context/events/EphemeralDelta.js';
import {
  MAX_CACHED_SESSION_EVENT_LOGS,
  SessionEventLog,
} from '../../../src/context/events/SessionEventLog.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { TokenBudgetHandoffRecordedV1 } from '../../../src/context/TokenBudgetHandoff.js';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../../src/context/types.js';
import { Bus } from '../../../src/server/bus.js';

function messageCreated(
  sessionId: string,
  projectPath: string,
  id: string
): SessionEvent {
  return {
    id,
    sessionId,
    projectPath,
    timestamp: '2024-01-01T00:00:00.000Z',
    type: 'message_created',
    cwd: projectPath,
    version: 'test',
    data: { messageId: id, role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
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

describe('SessionEventLog', () => {
  let projectPath: string;
  const sessionId = 'log-session';

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-log-'));
  });

  afterEach(async () => {
    SessionEventLog.release(sessionId, projectPath);
    await rm(projectPath, { recursive: true, force: true });
  });

  it('assigns a monotonic seq, persists, and reports lastSeq', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    const first = await log.commit(messageCreated(sessionId, projectPath, 'a'));
    const second = await log.commit(messageCreated(sessionId, projectPath, 'b'));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.lastSeq).toBe(2);

    const onDisk = await new JSONLStore(
      getSessionFilePath(projectPath, sessionId)
    ).readAll();
    expect(onDisk.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('fans committed events out to live subscribers', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    const seen: number[] = [];
    log.subscribe({
      onCommitted: (e) => {
        seen.push(e.seq ?? 0);
      },
    });

    await log.commit(messageCreated(sessionId, projectPath, 'a'));
    await log.commitBatch([
      messageCreated(sessionId, projectPath, 'b'),
      messageCreated(sessionId, projectPath, 'c'),
    ]);

    expect(seen).toEqual([1, 2, 3]);
  });

  it('replays committed events at or after fromSeq before live delivery', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    await log.commit(messageCreated(sessionId, projectPath, 'a'));
    await log.commit(messageCreated(sessionId, projectPath, 'b'));
    await log.commit(messageCreated(sessionId, projectPath, 'c'));

    const replayed: number[] = [];
    log.subscribe(
      {
        onCommitted: (e) => {
          replayed.push(e.seq ?? 0);
        },
      },
      { fromSeq: 2 }
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(replayed).toEqual([2, 3]);
  });

  it('fans deltas out without persisting or sequencing them', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    const committed = await log.commit(messageCreated(sessionId, projectPath, 'a'));

    const deltas: EphemeralDelta[] = [];
    const noop = () => undefined;
    log.subscribe({ onCommitted: noop, onDelta: (d) => deltas.push(d) });
    log.emitDelta({
      sessionId,
      projectPath,
      anchorSeq: committed.seq ?? 0,
      partId: 'p1',
      messageId: 'a',
      partType: 'text',
      channel: 'content',
      deltaIndex: 0,
      delta: 'hello',
    });

    expect(deltas).toHaveLength(1);
    const onDisk = await new JSONLStore(
      getSessionFilePath(projectPath, sessionId)
    ).readAll();
    expect(onDisk).toHaveLength(1); // only the committed message, no delta line
  });

  it('publishes deltas onto the Bus without a seq (never advances the cursor)', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    const busEvents: { type: string; seq?: number }[] = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === sessionId) busEvents.push(event);
    });

    try {
      log.emitDelta({
        sessionId,
        projectPath,
        anchorSeq: 0,
        partId: 'p1',
        messageId: 'a',
        partType: 'text',
        channel: 'content',
        deltaIndex: 0,
        delta: 'x',
      });

      const delta = busEvents.find((e) => e.type === 'delta');
      expect(delta).toBeDefined();
      expect(delta?.seq).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it('keeps token-budget handoff records durable while suppressing live, Bus, and replay fan-out', async () => {
    const log = SessionEventLog.for(sessionId, projectPath);
    const liveSeqs: number[] = [];
    const busCommitted = new Map<string, number[]>();
    const unsubscribeBus = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || !event.type.startsWith('committed.')) return;
      const observed = busCommitted.get(event.type) ?? [];
      observed.push(event.seq ?? 0);
      busCommitted.set(event.type, observed);
    });
    const unsubscribeLive = log.subscribe({
      onCommitted: (event) => {
        liveSeqs.push(event.seq ?? 0);
      },
    });

    try {
      await log.commit(messageCreated(sessionId, projectPath, 'visible-a'));
      await log.commit(
        tokenBudgetHandoffRecorded(sessionId, projectPath, 'handoff-record-1')
      );
      await log.commit(messageCreated(sessionId, projectPath, 'visible-b'));

      const onDisk = await new JSONLStore(
        getSessionFilePath(projectPath, sessionId)
      ).readAll();
      expect(onDisk.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(onDisk.map((event) => event.type)).toEqual([
        'message_created',
        'token_budget_handoff_recorded',
        'message_created',
      ]);
      expect(log.lastSeq).toBe(3);

      expect(liveSeqs).toEqual([1, 3]);
      expect(busCommitted).toEqual(
        new Map<string, number[]>([['committed.message_created', [1, 3]]])
      );

      const replayedSeqs: number[] = [];
      await log.replay(
        {
          onCommitted: async (event) => {
            replayedSeqs.push(event.seq ?? 0);
          },
        },
        1
      );
      expect(replayedSeqs).toEqual([1, 3]);
    } finally {
      unsubscribeLive();
      unsubscribeBus();
    }
  });

  it('shares one instance per project+session', () => {
    const a = SessionEventLog.for(sessionId, projectPath);
    const b = SessionEventLog.for(sessionId, projectPath);
    expect(a).toBe(b);
  });

  it('evicts the least recently used idle log when the cache reaches capacity', () => {
    const sessionIds = Array.from(
      { length: MAX_CACHED_SESSION_EVENT_LOGS + 1 },
      (_, index) => `bounded-log-${index}`
    );

    try {
      const oldest = SessionEventLog.for(sessionIds[0]!, projectPath);
      for (const candidate of sessionIds.slice(1)) {
        SessionEventLog.for(candidate, projectPath);
      }

      const newestId = sessionIds.at(-1)!;
      const newest = SessionEventLog.for(newestId, projectPath);
      expect(SessionEventLog.for(newestId, projectPath)).toBe(newest);
      expect(SessionEventLog.for(sessionIds[0]!, projectPath)).not.toBe(oldest);
    } finally {
      for (const candidate of sessionIds) {
        SessionEventLog.release(candidate, projectPath);
      }
    }
  });

  it('does not evict a log with a live subscriber', () => {
    const pinnedId = 'bounded-log-pinned';
    const otherIds = Array.from(
      { length: MAX_CACHED_SESSION_EVENT_LOGS },
      (_, index) => `bounded-log-other-${index}`
    );
    const pinned = SessionEventLog.for(pinnedId, projectPath);
    const unsubscribe = pinned.subscribe({ onCommitted: () => undefined });

    try {
      for (const candidate of otherIds) {
        SessionEventLog.for(candidate, projectPath);
      }
      expect(SessionEventLog.for(pinnedId, projectPath)).toBe(pinned);
    } finally {
      unsubscribe();
      SessionEventLog.release(pinnedId, projectPath);
      for (const candidate of otherIds) {
        SessionEventLog.release(candidate, projectPath);
      }
    }
  });

  it('keeps the newly returned log shared when every cached log is subscribed', () => {
    const pinnedIds = Array.from(
      { length: MAX_CACHED_SESSION_EVENT_LOGS },
      (_, index) => `bounded-log-subscribed-${index}`
    );
    const unsubscribers = pinnedIds.map((candidate) =>
      SessionEventLog.for(candidate, projectPath).subscribe({
        onCommitted: () => undefined,
      })
    );
    const nextId = 'bounded-log-after-subscribers';

    try {
      const next = SessionEventLog.for(nextId, projectPath);
      expect(SessionEventLog.for(nextId, projectPath)).toBe(next);
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      SessionEventLog.release(nextId, projectPath);
      for (const candidate of pinnedIds) {
        SessionEventLog.release(candidate, projectPath);
      }
    }
  });
});
