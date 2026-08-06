import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    JSONLStore,
    parseSessionJSONL,
} from '../../../src/context/storage/JSONLStore.js';
import type { SessionEvent } from '../../../src/context/types.js';

function createSessionCreated(
  sessionId: string,
  cwd: string,
  timestamp: string
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created`,
    sessionId,
    timestamp,
    type: 'session_created',
    cwd,
    gitBranch: 'main',
    version: 'test',
    data: {
      sessionId,
      rootId: sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function createSessionUpdated(
  sessionId: string,
  cwd: string,
  timestamp: string,
  title: string
): Extract<SessionEvent, { type: 'session_updated' }> {
  return {
    id: `${sessionId}-updated-${timestamp}`,
    sessionId,
    timestamp,
    type: 'session_updated',
    cwd,
    gitBranch: 'main',
    version: 'test',
    data: {
      sessionId,
      title,
      updatedAt: timestamp,
    },
  };
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error rejection, received ${String(error)}`);
  }
  throw new Error('Expected operation to reject');
}

/**
 * parseSessionJSONL 会为缺失 seq 的记录按解析顺序（1-based）回填 seq。
 * 断言解析/已提交结果时用它给期望值补上对应 seq。
 */
function withSeq<T extends SessionEvent>(event: T, seq: number): T {
  return { ...event, seq };
}

describe('JSONLStore.appendValidated', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'blade-jsonl-store-'));
    filePath = path.join(tempDir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('only updates existing files and never creates a missing transcript', async () => {
    const store = new JSONLStore(filePath);

    await expect(
      store.appendValidated((entries) =>
        createSessionUpdated(
          'missing-session',
          '/workspace',
          '2024-01-01T00:00:00.000Z',
          `${entries.length}`
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(filePath)).rejects.toThrow();
  });

  it('repairs a crash tail, passes committed entries to the callback, and appends one durable event', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n{"id":"cut-off`, 'utf8');
    const store = new JSONLStore(filePath);
    let callbackEntries: readonly SessionEvent[] = [];

    await store.appendValidated((entries) => {
      callbackEntries = entries;
      return createSessionUpdated(
        'session-1',
        '/workspace',
        '2024-01-01T00:00:01.000Z',
        'renamed'
      );
    });

    expect(callbackEntries).toEqual([withSeq(created, 1)]);
    const content = await readFile(filePath, 'utf8');
    const entries = parseSessionJSONL(content, filePath);
    expect(entries).toEqual([
      withSeq(created, 1),
      withSeq(
        createSessionUpdated(
          'session-1',
          '/workspace',
          '2024-01-01T00:00:01.000Z',
          'renamed'
        ),
        2
      ),
    ]);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('does not write anything when the builder throws', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);

    await expect(
      store.appendValidated(() => {
        throw new Error('builder failed');
      })
    ).rejects.toThrow('builder failed');

    expect(await readFile(filePath, 'utf8')).toBe(`${JSON.stringify(created)}\n`);
  });

  it('serializes append and appendValidated through one per-file queue without torn JSONL', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);
    const appended = createSessionUpdated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:01.000Z',
      'append'
    );
    const validated = createSessionUpdated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:02.000Z',
      'validated'
    );

    await Promise.all([store.append(appended), store.appendValidated(() => validated)]);

    const content = await readFile(filePath, 'utf8');
    expect(() => parseSessionJSONL(content, filePath)).not.toThrow();
    expect(parseSessionJSONL(content, filePath)).toEqual([
      withSeq(created, 1),
      withSeq(appended, 2),
      withSeq(validated, 3),
    ]);
  });

  it('holds the file queue while an async validated builder performs side effects', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);
    let releaseBuilder!: () => void;
    const builderGate = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    const rewind = createSessionUpdated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:01.000Z',
      'rewind'
    );
    const appended = createSessionUpdated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:02.000Z',
      'append'
    );

    const transaction = store.appendValidatedAsync(async (entries) => {
      expect(entries).toEqual([withSeq(created, 1)]);
      await builderGate;
      return rewind;
    });
    const append = store.append(appended);
    await Promise.resolve();

    expect(parseSessionJSONL(await readFile(filePath, 'utf8'), filePath)).toEqual([
      withSeq(created, 1),
    ]);
    releaseBuilder();
    await Promise.all([transaction, append]);

    expect(parseSessionJSONL(await readFile(filePath, 'utf8'), filePath)).toEqual([
      withSeq(created, 1),
      withSeq(rewind, 2),
      withSeq(appended, 3),
    ]);
  });

  it('lets a queued validated append complete before a queued delete', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);

    const update = store.appendValidated(() =>
      createSessionUpdated(
        'session-1',
        '/workspace',
        '2024-01-01T00:00:01.000Z',
        'queued-update'
      )
    );
    const deletion = store.delete();

    await Promise.all([update, deletion]);

    await expect(deletion).resolves.toBe(true);
    await expect(access(filePath)).rejects.toThrow();
  });

  it('reports whether delete removed an existing transcript', async () => {
    const missingStore = new JSONLStore(filePath);
    await expect(missingStore.delete()).resolves.toBe(false);

    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const existingStore = new JSONLStore(filePath);
    await expect(existingStore.delete()).resolves.toBe(true);
    await expect(access(filePath)).rejects.toThrow();
  });

  it('does not recreate the file when delete is queued before appendValidated', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);

    const deletion = store.delete();
    const update = store.appendValidated(() =>
      createSessionUpdated(
        'session-1',
        '/workspace',
        '2024-01-01T00:00:01.000Z',
        'should-fail'
      )
    );

    await expect(deletion).resolves.toBe(true);
    await expect(update).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(filePath)).rejects.toThrow();
  });

  it('keeps delete idempotent for missing files and shares the same queue with updates', async () => {
    const store = new JSONLStore(filePath);

    await expect(store.delete()).resolves.toBe(false);
    await expect(
      Promise.all([
        store.delete(),
        store.appendValidated(() =>
          createSessionUpdated(
            'session-1',
            '/workspace',
            '2024-01-01T00:00:01.000Z',
            'missing'
          )
        ),
      ])
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(filePath)).rejects.toThrow();
  });

  it('validates after an earlier append in the same-process per-file queue', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    const appended = createSessionUpdated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:01.000Z',
      'queued-before-delete'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);
    let validatedEntries: readonly SessionEvent[] = [];

    const append = store.append(appended);
    const deletion = store.deleteValidated((entries) => {
      validatedEntries = entries;
      return true;
    });

    await expect(append).resolves.toEqual(withSeq(appended, 2));
    await expect(deletion).resolves.toBe(true);
    expect(validatedEntries).toEqual([withSeq(created, 1), withSeq(appended, 2)]);
    await expect(access(filePath)).rejects.toThrow();
  });

  it('makes a later append fail when delete wins the same-process per-file queue', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');
    const store = new JSONLStore(filePath);

    const deletion = store.deleteValidated(() => true);
    const update = store.appendValidated(() =>
      createSessionUpdated(
        'session-1',
        '/workspace',
        '2024-01-01T00:00:01.000Z',
        'must-not-recreate'
      )
    );

    await expect(deletion).resolves.toBe(true);
    await expect(update).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(filePath)).rejects.toThrow();
  });

  it('keeps the transcript when validated delete is rejected by the validator', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    const original = `${JSON.stringify(created)}\n`;
    await writeFile(filePath, original, 'utf8');
    const store = new JSONLStore(filePath);

    await expect(store.deleteValidated(() => false)).resolves.toBe(false);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original);
  });

  it('keeps the transcript when the validated delete validator throws', async () => {
    const created = createSessionCreated(
      'session-1',
      '/workspace',
      '2024-01-01T00:00:00.000Z'
    );
    const original = `${JSON.stringify(created)}\n`;
    await writeFile(filePath, original, 'utf8');
    const store = new JSONLStore(filePath);

    await expect(
      store.deleteValidated(() => {
        throw new Error('validator rejected delete');
      })
    ).rejects.toThrow('validator rejected delete');
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original);
  });

  it('does not expose transcript paths when validated delete finds corrupt JSONL', async () => {
    await writeFile(filePath, '{"broken":}\n', 'utf8');
    const store = new JSONLStore(filePath);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const error = await captureError(() => store.deleteValidated(() => true));
      const logged = consoleError.mock.calls.flat().map(String).join(' ');
      expect(error.message).toContain('Invalid session JSONL');
      expect(error.message).toContain('line 1');
      expect(error.message).not.toContain(filePath);
      expect(error.message).not.toContain(tempDir);
      expect(logged).not.toContain(filePath);
      expect(logged).not.toContain(tempDir);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not expose transcript paths when validated append finds corrupt JSONL', async () => {
    await writeFile(filePath, '{"broken":}\n', 'utf8');
    const store = new JSONLStore(filePath);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const error = await captureError(() =>
        store.appendValidated(() =>
          createSessionUpdated(
            'session-1',
            '/workspace',
            '2024-01-01T00:00:01.000Z',
            'must-not-append'
          )
        )
      );
      const logged = consoleError.mock.calls.flat().map(String).join(' ');
      expect(error.message).toContain('Invalid session JSONL');
      expect(error.message).toContain('line 1');
      expect(error.message).not.toContain(filePath);
      expect(error.message).not.toContain(tempDir);
      expect(logged).not.toContain(filePath);
      expect(logged).not.toContain(tempDir);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('JSONLStore sequence numbers', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'blade-jsonl-seq-'));
    filePath = path.join(tempDir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('backfills a 1-based monotonic seq for legacy records that lack one', async () => {
    const created = createSessionCreated('s', '/w', '2024-01-01T00:00:00.000Z');
    const updated = createSessionUpdated('s', '/w', '2024-01-01T00:00:01.000Z', 't');
    await writeFile(
      filePath,
      `${JSON.stringify(created)}\n${JSON.stringify(updated)}\n`,
      'utf8'
    );

    const entries = await new JSONLStore(filePath).readAll();
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('preserves an explicit seq and does not overwrite it', async () => {
    const created = withSeq(
      createSessionCreated('s', '/w', '2024-01-01T00:00:00.000Z'),
      7
    );
    await writeFile(filePath, `${JSON.stringify(created)}\n`, 'utf8');

    const [entry] = await new JSONLStore(filePath).readAll();
    expect(entry.seq).toBe(7);
  });

  it('readFromSeq returns only records at or after the cursor', async () => {
    const created = createSessionCreated('s', '/w', '2024-01-01T00:00:00.000Z');
    const a = createSessionUpdated('s', '/w', '2024-01-01T00:00:01.000Z', 'a');
    const b = createSessionUpdated('s', '/w', '2024-01-01T00:00:02.000Z', 'b');
    await writeFile(
      filePath,
      `${JSON.stringify(created)}\n${JSON.stringify(a)}\n${JSON.stringify(b)}\n`,
      'utf8'
    );

    const store = new JSONLStore(filePath);
    expect((await store.readFromSeq(2)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.readFromSeq(1)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await store.readFromSeq(4)).toEqual([]);
  });

  it('assigns gapless monotonic seq across many sequential appends (tail-based base)', async () => {
    const store = new JSONLStore(filePath);
    for (let i = 0; i < 50; i++) {
      const event = await store.append(
        createSessionUpdated('s', '/w', `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, `t${i}`)
      );
      expect(event.seq).toBe(i + 1);
    }
    const entries = await store.readAll();
    expect(entries.map((e) => e.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1)
    );
  });

  it('continues seq after a legacy tail that lacks a seq, then stays tail-based', async () => {
    // Legacy transcript: two records written without seq.
    const created = createSessionCreated('s', '/w', '2024-01-01T00:00:00.000Z');
    const legacy = createSessionUpdated('s', '/w', '2024-01-01T00:00:01.000Z', 'legacy');
    await writeFile(
      filePath,
      `${JSON.stringify(created)}\n${JSON.stringify(legacy)}\n`,
      'utf8'
    );

    const store = new JSONLStore(filePath);
    // First append: legacy tail lacks seq → full-parse fallback backfills base=2.
    const first = await store.append(
      createSessionUpdated('s', '/w', '2024-01-01T00:00:02.000Z', 'new-1')
    );
    expect(first.seq).toBe(3);
    // Second append: tail now carries seq=3 → pure tail-based continuation.
    const second = await store.append(
      createSessionUpdated('s', '/w', '2024-01-01T00:00:03.000Z', 'new-2')
    );
    expect(second.seq).toBe(4);
  });
});
