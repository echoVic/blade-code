import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionEventLog } from '../../../src/context/events/SessionEventLog.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import type { BusEvent } from '../../../src/server/bus.js';
import { Bus } from '../../../src/server/bus.js';

const sessionId = 'tool-history-session';

describe('committed result events (tool history)', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-tool-hist-'));
  });

  afterEach(async () => {
    SessionEventLog.release(sessionId, projectPath);
    await rm(projectPath, { recursive: true, force: true });
  });

  it('persists a tool call + result and replays them from JSONL with monotonic seq', async () => {
    const store = new PersistentStore(projectPath);
    const messageId = await store.saveMessage(
      sessionId,
      'assistant',
      'running a tool',
      null,
      undefined,
      undefined,
      'inspect before running'
    );
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Read',
      { path: '/tmp/x' },
      messageId
    );
    await store.saveToolResult(
      sessionId,
      toolCallId,
      'Read',
      { text: 'file contents' },
      messageId,
      undefined,
      undefined,
      undefined,
      {
        file_path: '/tmp/x',
        summary: 'Read x',
      }
    );

    const entries = await new JSONLStore(
      getSessionFilePath(projectPath, sessionId)
    ).readAll();

    // seq is monotonic and gapless across the whole committed transcript.
    expect(entries.map((e) => e.seq)).toEqual(
      Array.from({ length: entries.length }, (_, i) => i + 1)
    );

    // The tool call and tool result survive as durable part_created events.
    const toolCall = entries.find(
      (e): e is Extract<SessionEvent, { type: 'part_created' }> =>
        e.type === 'part_created' && e.data.partType === 'tool_call'
    );
    const toolResult = entries.find(
      (e): e is Extract<SessionEvent, { type: 'part_created' }> =>
        e.type === 'part_created' && e.data.partType === 'tool_result'
    );
    const reasoning = entries.find(
      (e): e is Extract<SessionEvent, { type: 'part_created' }> =>
        e.type === 'part_created' && e.data.partType === 'reasoning'
    );
    expect(reasoning?.data.payload).toEqual({ text: 'inspect before running' });
    expect(toolCall?.data.payload).toMatchObject({ toolName: 'Read' });
    expect(toolResult?.data.payload).toMatchObject({
      toolName: 'Read',
      metadata: {
        file_path: '/tmp/x',
        summary: 'Read x',
      },
    });
  });

  it('fans committed events onto the Bus carrying their seq', async () => {
    const received: BusEvent[] = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === sessionId && event.type.startsWith('committed.')) {
        received.push(event);
      }
    });

    try {
      const store = new PersistentStore(projectPath);
      await store.saveMessage(sessionId, 'user', 'hi');

      expect(received.length).toBeGreaterThan(0);
      for (const event of received) {
        expect(typeof event.seq).toBe('number');
        expect(event.properties.event).toBeDefined();
      }
    } finally {
      unsubscribe();
    }
  });
});
