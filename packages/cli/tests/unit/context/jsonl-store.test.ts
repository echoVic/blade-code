import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function invokeAppendValidated(
  store: JSONLStore,
  buildEntry: (entries: readonly SessionEvent[]) => SessionEvent
): Promise<void> {
  const method = Reflect.get(store, 'appendValidated') as
    | ((builder: (entries: readonly SessionEvent[]) => SessionEvent) => Promise<void>)
    | undefined;
  if (!method) {
    throw new Error('appendValidated is not implemented');
  }
  await method.call(store, buildEntry);
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
      invokeAppendValidated(store, (entries) =>
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

    await invokeAppendValidated(store, (entries) => {
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
      invokeAppendValidated(store, () => {
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

    await Promise.all([
      store.append(appended),
      invokeAppendValidated(store, () => validated),
    ]);

    const content = await readFile(filePath, 'utf8');
    expect(() => parseSessionJSONL(content, filePath)).not.toThrow();
    expect(parseSessionJSONL(content, filePath)).toEqual([
      created,
      appended,
      validated,
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

    const update = invokeAppendValidated(store, () =>
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
    const update = invokeAppendValidated(store, () =>
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
        invokeAppendValidated(store, () =>
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
});
