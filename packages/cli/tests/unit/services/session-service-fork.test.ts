import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService.forkSession', () => {
  let storageRoot: string;
  let projectPath: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-store-'));
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-project-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(projectPath, { recursive: true, force: true }),
    ]);
  });

  it('copies committed history into an independent child and leaves the parent immutable', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'Remember FORK_VALUE');
    await persistentStore.saveMessage('parent-session', 'assistant', 'READY');

    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');
    const parentEvents = parentBeforeFork
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);

    const fork = await SessionService.forkSession('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    expect(fork).toMatchObject({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      projectPath,
      messages: [
        { role: 'user', content: 'Remember FORK_VALUE' },
        { role: 'assistant', content: 'READY' },
      ],
    });
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);

    const childPath = getSessionFilePath(projectPath, 'child-session');
    const childEvents = (await readFile(childPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);
    const created = childEvents[0];
    expect(created).toMatchObject({
      type: 'session_created',
      sessionId: 'child-session',
      cwd: projectPath,
      data: {
        sessionId: 'child-session',
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
      },
    });
    expect(childEvents.every((event) => event.sessionId === 'child-session')).toBe(
      true
    );
    expect(
      childEvents.every(
        (event) => !parentEvents.some((parent) => parent.id === event.id)
      )
    ).toBe(true);
    expect(childEvents.at(-1)).toMatchObject({
      type: 'session_updated',
      sessionId: 'child-session',
      data: {
        parentId: 'parent-session',
        relationType: 'fork',
      },
    });

    await persistentStore.saveMessage('child-session', 'user', 'CHILD_ONLY');
    expect(
      await SessionService.loadSession('parent-session', projectPath)
    ).not.toContainEqual(expect.objectContaining({ content: 'CHILD_ONLY' }));
    expect(
      await SessionService.loadSession('child-session', projectPath)
    ).toContainEqual(expect.objectContaining({ content: 'CHILD_ONLY' }));
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);
  });

  it('fails closed when the requested child ID already exists', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');
    await persistentStore.saveMessage('child-session', 'user', 'existing child');
    const childPath = getSessionFilePath(projectPath, 'child-session');
    const childBeforeFork = await readFile(childPath, 'utf-8');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(/already exists|EEXIST/i);

    expect(await readFile(childPath, 'utf-8')).toBe(childBeforeFork);
  });

  it('rejects child IDs that can escape the project session directory', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: '../outside',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid fork session ID');
  });

  it('preserves the root across fork chains and ignores an uncommitted crash tail', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('root-session', 'user', 'committed history');
    await SessionService.forkSession('root-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });
    const childPath = getSessionFilePath(projectPath, 'child-session');
    await appendFile(childPath, '{"id":"incomplete"', 'utf-8');
    const childBeforeFork = await readFile(childPath, 'utf-8');

    await SessionService.forkSession('child-session', {
      newSessionId: 'grandchild-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });

    expect(await readFile(childPath, 'utf-8')).toBe(childBeforeFork);
    const grandchildPath = getSessionFilePath(projectPath, 'grandchild-session');
    const grandchildEvents = (await readFile(grandchildPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SessionEvent);
    expect(grandchildEvents[0]).toMatchObject({
      type: 'session_created',
      data: {
        rootId: 'root-session',
        parentId: 'child-session',
        relationType: 'fork',
      },
    });
    expect(
      await SessionService.loadSession('grandchild-session', projectPath)
    ).toContainEqual(expect.objectContaining({ content: 'committed history' }));
  });

  it('deletes the durable inbox together with the session transcript', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('delete-session', 'user', 'committed');
    const transcriptPath = getSessionFilePath(projectPath, 'delete-session');
    const inboxPath = getSessionInboxFilePath(projectPath, 'delete-session');
    await writeFile(
      inboxPath,
      '{"version":1,"sessionId":"delete-session","messages":[]}\n',
      'utf8'
    );
    expect(
      (await SessionService.listSessions()).find(
        (session) => session.sessionId === 'delete-session'
      )?.projectPath
    ).toBe(projectPath);

    expect(await SessionService.deleteSession('delete-session')).toBe(1);
    await expect(access(transcriptPath)).rejects.toThrow();
    await expect(access(inboxPath)).rejects.toThrow();
  });
});
