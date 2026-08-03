import type { BigIntStats } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import {
  getSessionFilePath,
  getSessionInboxFilePath,
} from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import * as SessionServiceModule from '../../../src/services/SessionService.js';
import { SessionService } from '../../../src/services/SessionService.js';

function makeCreatedEvent(
  sessionId: string,
  cwd: string,
  timestamp: string,
  overrides: Partial<Extract<SessionEvent, { type: 'session_created' }>['data']> = {}
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${sessionId}-created-${timestamp}`,
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
      ...overrides,
    },
  };
}

function makeMessageEvents(
  sessionId: string,
  cwd: string,
  timestamp: string,
  text: string,
  inboxMessageId?: string
): SessionEvent[] {
  return [
    {
      id: `${sessionId}-message-${timestamp}`,
      sessionId,
      timestamp,
      type: 'message_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        messageId: `${sessionId}-message-${timestamp}`,
        role: 'user',
        inboxMessageId,
        createdAt: timestamp,
      },
    },
    {
      id: `${sessionId}-part-${timestamp}`,
      sessionId,
      timestamp,
      type: 'part_created',
      cwd,
      gitBranch: 'main',
      version: 'test',
      data: {
        partId: `${sessionId}-part-${timestamp}`,
        messageId: `${sessionId}-message-${timestamp}`,
        partType: 'text',
        payload: { text },
        createdAt: timestamp,
      },
    },
  ];
}

async function writeTranscript(
  workspace: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<void> {
  const filePath = getSessionFilePath(workspace, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await new JSONLStore(filePath).createExclusive(entries);
}

async function readTranscript(filePath: string): Promise<SessionEvent[]> {
  return (await readFile(filePath, 'utf-8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

type SnapshotBigIntStats = BigIntStats;

interface TestSessionSnapshotIO {
  stat(filePath: string): Promise<SnapshotBigIntStats>;
  readFile(filePath: string): Promise<string>;
}

function getSnapshotTestingHooks(): {
  setSnapshotIO: ((io: TestSessionSnapshotIO) => void) | undefined;
  resetSnapshotIO: (() => void) | undefined;
} {
  return {
    setSnapshotIO: Reflect.get(
      SessionServiceModule,
      '__setSessionSnapshotIOForTesting'
    ) as ((io: TestSessionSnapshotIO) => void) | undefined,
    resetSnapshotIO: Reflect.get(
      SessionServiceModule,
      '__resetSessionSnapshotIOForTesting'
    ) as (() => void) | undefined,
  };
}

describe('SessionService.forkSession', () => {
  let storageRoot: string;
  let projectPath: string;
  let otherProjectPath: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-store-'));
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-session-fork-project-'));
    otherProjectPath = await mkdtemp(
      path.join(os.tmpdir(), 'blade-session-fork-other-project-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    getSnapshotTestingHooks().resetSnapshotIO?.();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(projectPath, { recursive: true, force: true }),
      rm(otherProjectPath, { recursive: true, force: true }),
    ]);
  });

  it('copies committed history into an independent child and leaves the parent immutable', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'Remember FORK_VALUE');
    await persistentStore.saveMessage('parent-session', 'assistant', 'READY');
    await persistentStore.acknowledgeInboxMessages('parent-session', [
      'parent-only-inbox-id',
    ]);

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
    expect(fork.metadata).toMatchObject({
      sessionId: 'child-session',
      rootId: 'parent-session',
      parentId: 'parent-session',
      relationType: 'fork',
      projectPath,
    });
    expect('filePath' in fork.metadata).toBe(false);
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
    expect(childEvents.some((event) => event.type === 'inbox_acknowledged')).toBe(
      false
    );
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

  it('rejects non-absolute or cross-workspace fork paths before reading transcripts', async () => {
    await expect(
      SessionService.forkSession('parent-session', {
        sourceProjectPath: 'relative/source',
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Fork workspace paths must be absolute');

    await expect(
      SessionService.forkSession('parent-session', {
        sourceProjectPath: projectPath,
        targetProjectPath: otherProjectPath,
      })
    ).rejects.toThrow('Session forks must stay in the source workspace');
  });

  it('validates source and target session IDs before any filesystem access', async () => {
    await expect(
      SessionService.forkSession('../bad-source', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid session ID: ../bad-source');

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: '../outside',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow('Invalid session ID: ../outside');
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
    ).rejects.toThrow('Invalid session ID: ../outside');
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

  it('fails closed when the committed creation payload sessionId mismatches the request source ID', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z', {
        sessionId: 'different-source',
      }),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(
      'Fork source session_created.data.sessionId must match the requested session ID'
    );
    await expect(
      access(getSessionFilePath(projectPath, 'child-session'))
    ).rejects.toThrow();
  });

  it('fails closed when the committed creation cwd does not resolve to the source workspace', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', otherProjectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);

    await expect(
      SessionService.forkSession('parent-session', {
        newSessionId: 'child-session',
        sourceProjectPath: projectPath,
        targetProjectPath: projectPath,
      })
    ).rejects.toThrow(
      'Fork source session_created.cwd must resolve to the requested source workspace'
    );
    await expect(
      access(getSessionFilePath(projectPath, 'child-session'))
    ).rejects.toThrow();
  });

  it('retries on a changing source transcript and forks from a stable full snapshot', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'before append'
      ),
    ]);
    const appendedLines =
      makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:02.000Z',
        'after append'
      )
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n';
    const parentPath = getSessionFilePath(projectPath, 'parent-session');

    const forkPromise = SessionService.forkSession('parent-session', {
      newSessionId: 'child-session',
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    });
    await appendFile(parentPath, appendedLines, 'utf-8');
    const fork = await forkPromise;

    const contents = fork.messages.map((message) => message.content);
    expect(
      JSON.stringify(contents) === JSON.stringify(['before append']) ||
        JSON.stringify(contents) === JSON.stringify(['before append', 'after append'])
    ).toBe(true);
    expect(contents).not.toEqual(['after append']);
  });

  it('fails after three unstable snapshot attempts and leaves no child transcript', async () => {
    await writeTranscript(projectPath, 'parent-session', [
      makeCreatedEvent('parent-session', projectPath, '2024-01-01T00:00:00.000Z'),
      ...makeMessageEvents(
        'parent-session',
        projectPath,
        '2024-01-01T00:00:01.000Z',
        'parent history'
      ),
    ]);
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentContent = await readFile(parentPath, 'utf-8');
    const baseStats = await stat(parentPath, { bigint: true });
    const statsSequence: SnapshotBigIntStats[] = [
      { ...baseStats, size: baseStats.size + 1n },
      { ...baseStats, size: baseStats.size + 2n },
      {
        ...baseStats,
        size: baseStats.size + 3n,
        mtimeNs: baseStats.mtimeNs + 1n,
      },
      {
        ...baseStats,
        size: baseStats.size + 4n,
        mtimeNs: baseStats.mtimeNs + 2n,
      },
      {
        ...baseStats,
        size: baseStats.size + 5n,
        mtimeNs: baseStats.mtimeNs + 3n,
      },
      {
        ...baseStats,
        size: baseStats.size + 6n,
        mtimeNs: baseStats.mtimeNs + 4n,
      },
    ];
    const { setSnapshotIO, resetSnapshotIO } = getSnapshotTestingHooks();
    expect(setSnapshotIO).toBeTypeOf('function');
    expect(resetSnapshotIO).toBeTypeOf('function');

    let statCallCount = 0;
    let readCallCount = 0;
    setSnapshotIO?.({
      async stat(filePath) {
        expect(filePath).toBe(parentPath);
        const next = statsSequence[statCallCount];
        statCallCount += 1;
        if (!next) {
          throw new Error('Exhausted unstable stat fixtures');
        }
        return next;
      },
      async readFile(filePath) {
        expect(filePath).toBe(parentPath);
        readCallCount += 1;
        return parentContent;
      },
    });

    try {
      await expect(
        SessionService.forkSession('parent-session', {
          newSessionId: 'unstable-child',
          sourceProjectPath: projectPath,
          targetProjectPath: projectPath,
        })
      ).rejects.toThrow('Session changed while creating fork; retry the operation');
      expect(statCallCount).toBe(6);
      expect(readCallCount).toBe(3);
      await expect(
        access(getSessionFilePath(projectPath, 'unstable-child'))
      ).rejects.toThrow();
    } finally {
      resetSnapshotIO?.();
    }
  });

  it('creates unique auto-generated child IDs for concurrent forks without mutating the parent', async () => {
    const persistentStore = new PersistentStore(projectPath, 100, 'test');
    await persistentStore.saveMessage('parent-session', 'user', 'parent');
    await persistentStore.saveMessage('parent-session', 'assistant', 'baseline');
    const parentPath = getSessionFilePath(projectPath, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');

    const forks = await Promise.all(
      Array.from({ length: 8 }, () =>
        SessionService.forkSession('parent-session', {
          sourceProjectPath: projectPath,
          targetProjectPath: projectPath,
        })
      )
    );

    expect(new Set(forks.map((fork) => fork.sessionId)).size).toBe(8);
    expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);

    for (const fork of forks) {
      expect(fork.metadata).toMatchObject({
        sessionId: fork.sessionId,
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
        projectPath,
      });
      await expect(
        SessionService.loadSession(fork.sessionId, projectPath)
      ).resolves.toEqual([
        { role: 'user', content: 'parent' },
        { role: 'assistant', content: 'baseline' },
      ]);
      const childEntries = await readTranscript(
        getSessionFilePath(projectPath, fork.sessionId)
      );
      expect(childEntries[0]).toMatchObject({
        type: 'session_created',
        sessionId: fork.sessionId,
        data: {
          rootId: 'parent-session',
          parentId: 'parent-session',
          relationType: 'fork',
        },
      });
      expect(childEntries.every((entry) => entry.sessionId === fork.sessionId)).toBe(
        true
      );
    }

    const [firstFork, secondFork] = forks;
    await persistentStore.saveMessage(firstFork.sessionId, 'user', 'first child only');
    await expect(
      SessionService.loadSession(firstFork.sessionId, projectPath)
    ).resolves.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
    await expect(
      SessionService.loadSession(secondFork.sessionId, projectPath)
    ).resolves.not.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
    await expect(
      SessionService.loadSession('parent-session', projectPath)
    ).resolves.not.toContainEqual(
      expect.objectContaining({ role: 'user', content: 'first child only' })
    );
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
