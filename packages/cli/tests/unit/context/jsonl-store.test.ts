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

    expect(callbackEntries).toEqual([created]);
    const content = await readFile(filePath, 'utf8');
    const entries = parseSessionJSONL(content, filePath);
    expect(entries).toEqual([
      created,
      createSessionUpdated(
        'session-1',
        '/workspace',
        '2024-01-01T00:00:01.000Z',
        'renamed'
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
      created,
      appended,
      validated,
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
      expect(entries).toEqual([created]);
      await builderGate;
      return rewind;
    });
    const append = store.append(appended);
    await Promise.resolve();

    expect(parseSessionJSONL(await readFile(filePath, 'utf8'), filePath)).toEqual([
      created,
    ]);
    releaseBuilder();
    await Promise.all([transaction, append]);

    expect(parseSessionJSONL(await readFile(filePath, 'utf8'), filePath)).toEqual([
      created,
      rewind,
      appended,
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

    await expect(append).resolves.toBeUndefined();
    await expect(deletion).resolves.toBe(true);
    expect(validatedEntries).toEqual([created, appended]);
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
