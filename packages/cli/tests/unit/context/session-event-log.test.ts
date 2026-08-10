import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EphemeralDelta } from '../../../src/context/events/EphemeralDelta.js';
import { SessionEventLog } from '../../../src/context/events/SessionEventLog.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
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
    log.subscribe({ onCommitted: (e) => seen.push(e.seq ?? 0) });

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
    log.subscribe({ onCommitted: (e) => replayed.push(e.seq ?? 0) }, { fromSeq: 2 });
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

  it('shares one instance per project+session', () => {
    const a = SessionEventLog.for(sessionId, projectPath);
    const b = SessionEventLog.for(sessionId, projectPath);
    expect(a).toBe(b);
  });
});
