import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';

function parseTranscript(content: string): SessionEvent[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('PersistentStore session initialization', () => {
  const initializationCacheCapacity = 256;
  let storageRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-persistent-init-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('commits one session_created event across concurrent facades', async () => {
    const sessionId = 'concurrent-first-write';
    const left = new PersistentStore(workspaceRoot, 100, 'test');
    const right = new PersistentStore(workspaceRoot, 100, 'test');

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? left : right).saveMessage(
          sessionId,
          'user',
          `message-${index}`
        )
      )
    );

    const events = parseTranscript(
      await readFile(getSessionFilePath(workspaceRoot, sessionId), 'utf8')
    );
    expect(events.filter((event) => event.type === 'session_created')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message_created')).toHaveLength(16);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 33 }, (_, index) => index + 1)
    );
  });

  it('validates initialization once before ordinary hot-path appends', async () => {
    const sessionId = 'hot-path';
    const readAll = vi.spyOn(JSONLStore.prototype, 'readAll');
    const store = new PersistentStore(workspaceRoot, 100, 'test');

    await store.initSession(sessionId);
    await store.saveMessage(sessionId, 'user', 'first');
    await store.saveMessage(sessionId, 'assistant', 'second');
    await store.saveToolUse(sessionId, 'Read', { file_path: '/workspace/a.ts' });

    expect(readAll).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed validation and retries after repair', async () => {
    const sessionId = 'retry-after-corruption';
    const filePath = getSessionFilePath(workspaceRoot, sessionId);
    const store = new PersistentStore(workspaceRoot, 100, 'test');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"type":\n', 'utf8');

    await expect(store.initSession(sessionId)).rejects.toThrow('Invalid session JSONL');

    await writeFile(filePath, '', 'utf8');
    await store.initSession(sessionId);
    await store.saveMessage(sessionId, 'user', 'recovered');

    const events = parseTranscript(await readFile(filePath, 'utf8'));
    expect(events.filter((event) => event.type === 'session_created')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message_created')).toHaveLength(1);
  });

  it('invalidates the positive cache when the facade deletes a session', async () => {
    const sessionId = 'delete-and-recreate';
    const store = new PersistentStore(workspaceRoot, 100, 'test');

    await store.initSession(sessionId);
    await store.deleteSession(sessionId);
    await store.saveMessage(sessionId, 'user', 'new generation');

    const events = parseTranscript(
      await readFile(getSessionFilePath(workspaceRoot, sessionId), 'utf8')
    );
    expect(events[0]?.type).toBe('session_created');
    expect(events.filter((event) => event.type === 'session_created')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message_created')).toHaveLength(1);
  });

  it('bounds positive initialization state with LRU revalidation', async () => {
    const readAll = vi.spyOn(JSONLStore.prototype, 'readAll');
    const store = new PersistentStore(workspaceRoot, 100, 'test');

    for (let index = 0; index <= initializationCacheCapacity; index++) {
      await store.initSession(`bounded-${index}`);
    }
    expect(readAll).toHaveBeenCalledTimes(initializationCacheCapacity + 1);

    await store.initSession('bounded-0');
    expect(readAll).toHaveBeenCalledTimes(initializationCacheCapacity + 2);

    await store.initSession(`bounded-${initializationCacheCapacity}`);
    expect(readAll).toHaveBeenCalledTimes(initializationCacheCapacity + 2);
  });
});
