import type { Session, SessionRef } from '@api/schemas';
import { describe, expect, it } from 'vitest';
import { sessionRefKey } from '../../../src/store/session/sessionIdentity';
import {
  acknowledgeTaskTerminal,
  persistTaskTerminalReadLedger,
  persistUnreadTaskKeys,
  pruneAndCompactTaskTerminalReadLedger,
  pruneUnreadTaskKeys,
  readTaskTerminalReadLedger,
  readUnreadTaskKeys,
  reconcileTaskAttention,
  shouldMarkTaskUnread,
  type TaskTerminalReadLedgerEntry,
  type TaskTerminalReadLedgerV1,
  taskTerminalSignature,
} from '../../../src/store/session/taskAttention';

const TASK_TERMINAL_READ_LEDGER_KEY = 'blade.tasks.terminal-read-ledger.v1';
const COMPLETED_AT = '2026-09-04T01:02:03.000Z';
const COMPLETED_SIGNATURE = JSON.stringify(['completed', COMPLETED_AT, null]);

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error('read unavailable');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error('write unavailable');
    this.values.set(key, value);
  }
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    rootId: 'session-1',
    taskStatus: 'running',
    messageCount: 1,
    firstMessageTime: '2026-09-04T00:00:00.000Z',
    lastMessageTime: '2026-09-04T00:01:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function refFor(session: Session): SessionRef {
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
  };
}

function keyFor(session: Session): string {
  return sessionRefKey(refFor(session));
}

function entryFor(session: Session): TaskTerminalReadLedgerEntry {
  return {
    key: keyFor(session),
    signature: taskTerminalSignature(session),
  };
}

function ledger(
  entries: readonly TaskTerminalReadLedgerEntry[] = []
): TaskTerminalReadLedgerV1 {
  return { version: 1, entries: [...entries] };
}

describe('taskAttention', () => {
  it('only marks new background terminal transitions unread', () => {
    expect(shouldMarkTaskUnread('running', 'completed', false)).toBe(true);
    expect(shouldMarkTaskUnread('queued', 'failed', false)).toBe(true);
    expect(shouldMarkTaskUnread('running', 'interrupted', false)).toBe(true);
    expect(shouldMarkTaskUnread('running', 'completed', true)).toBe(false);
    expect(shouldMarkTaskUnread('completed', 'completed', false)).toBe(false);
    expect(shouldMarkTaskUnread('failed', 'completed', false)).toBe(false);
    expect(shouldMarkTaskUnread('running', 'cancelled', false)).toBe(false);
  });

  it('persists unique unread keys and tolerates malformed storage', () => {
    const storage = new MemoryStorage();

    persistUnreadTaskKeys(['a', 'a', 'b'], storage);
    expect(readUnreadTaskKeys(storage)).toEqual(['a', 'b']);

    storage.values.set('blade.tasks.unread', '{bad json');
    expect(readUnreadTaskKeys(storage)).toEqual([]);
  });

  it('prunes unread references no longer present in the catalog', () => {
    expect(
      pruneUnreadTaskKeys(
        [
          JSON.stringify(['/workspace/a', 'session-1']),
          JSON.stringify(['/workspace/missing', 'session-1']),
        ],
        [createSession()]
      )
    ).toEqual([JSON.stringify(['/workspace/a', 'session-1'])]);
  });

  describe('terminal signatures', () => {
    it('uses null for running tasks and the exact canonical terminal grammar', () => {
      expect(taskTerminalSignature(createSession())).toBeNull();
      expect(
        taskTerminalSignature(
          createSession({
            taskStatus: 'completed',
            taskCompletedAt: '2026-09-04T01:02:03Z',
          })
        )
      ).toBe(COMPLETED_SIGNATURE);
    });

    it('includes only a validated failure code and excludes free-form text', () => {
      const failed = createSession({
        taskStatus: 'failed',
        taskCompletedAt: COMPLETED_AT,
        taskStatusReason: 'secret status reason',
        taskFailure: {
          code: 'timeout',
          message: 'secret provider failure details',
          retryable: true,
        },
      });

      const signature = taskTerminalSignature(failed);

      expect(signature).toBe(JSON.stringify(['failed', COMPLETED_AT, 'timeout']));
      expect(signature).not.toContain(failed.taskFailure?.message ?? '');
      expect(signature).not.toContain(failed.taskStatusReason ?? '');
    });

    it('normalizes an invalid completion date to null', () => {
      expect(
        taskTerminalSignature(
          createSession({
            taskStatus: 'interrupted',
            taskCompletedAt: 'not-a-date',
          })
        )
      ).toBe(JSON.stringify(['interrupted', null, null]));
    });
  });

  describe('terminal read ledger persistence', () => {
    it('returns an empty v1 ledger for missing, corrupt, unsupported, or failed reads', () => {
      const storage = new MemoryStorage();
      const emptyLedger = ledger();

      expect(readTaskTerminalReadLedger(storage)).toEqual(emptyLedger);

      storage.values.set(TASK_TERMINAL_READ_LEDGER_KEY, '{bad json');
      expect(readTaskTerminalReadLedger(storage)).toEqual(emptyLedger);

      storage.values.set(
        TASK_TERMINAL_READ_LEDGER_KEY,
        JSON.stringify({ version: 2, entries: [] })
      );
      expect(readTaskTerminalReadLedger(storage)).toEqual(emptyLedger);

      storage.throwOnRead = true;
      expect(readTaskTerminalReadLedger(storage)).toEqual(emptyLedger);
    });

    it('accepts canonical absolute compound keys and keeps duplicate keys last-wins', () => {
      const storage = new MemoryStorage();
      const posixKey = JSON.stringify(['/workspace/a', 'shared-session']);
      const win32Key = JSON.stringify(['C:\\workspace\\blade', 'win-session']);
      const uncKey = JSON.stringify(['\\\\server\\share\\blade', 'unc-session']);
      const duplicateSignature = JSON.stringify(['failed', COMPLETED_AT, 'network']);
      const oversizedKey = JSON.stringify([`/${'a'.repeat(16_384)}`, 'large']);

      storage.values.set(
        TASK_TERMINAL_READ_LEDGER_KEY,
        JSON.stringify({
          version: 1,
          entries: [
            { key: posixKey, signature: null },
            { key: win32Key, signature: COMPLETED_SIGNATURE },
            { key: uncKey, signature: null },
            {
              key: JSON.stringify(['relative/project', 'relative-session']),
              signature: null,
            },
            { key: JSON.stringify(['/workspace/empty', '']), signature: null },
            {
              key: JSON.stringify(['/workspace/a', 'session', 'extra']),
              signature: null,
            },
            {
              key: JSON.stringify(['/workspace/b', 'bad-signature']),
              signature: JSON.stringify(['completed', 'not-a-date', null]),
            },
            {
              key: JSON.stringify(['/workspace/c', 'bad-code']),
              signature: JSON.stringify(['failed', COMPLETED_AT, 'made-up']),
            },
            { key: oversizedKey, signature: null },
            { key: posixKey, signature: duplicateSignature },
          ],
        })
      );

      expect(readTaskTerminalReadLedger(storage)).toEqual(
        ledger([
          { key: win32Key, signature: COMPLETED_SIGNATURE },
          { key: uncKey, signature: null },
          { key: posixKey, signature: duplicateSignature },
        ])
      );
    });

    it('persists a versioned payload and fails soft when storage rejects writes', () => {
      const storage = new MemoryStorage();
      const value = ledger([
        {
          key: JSON.stringify(['/workspace/a', 'session-1']),
          signature: COMPLETED_SIGNATURE,
        },
      ]);

      persistTaskTerminalReadLedger(value, storage);

      expect([...storage.values.keys()]).toEqual([TASK_TERMINAL_READ_LEDGER_KEY]);
      expect(storage.values.get(TASK_TERMINAL_READ_LEDGER_KEY)).toBe(
        JSON.stringify(value)
      );

      storage.throwOnWrite = true;
      expect(() => persistTaskTerminalReadLedger(value, storage)).not.toThrow();
    });
  });

  describe('terminal read ledger acknowledgement and compaction', () => {
    it('moves a re-acknowledged terminal entry to the MRU end without mutation', () => {
      const first = createSession({
        projectPath: '/workspace/a',
        sessionId: 'shared-session',
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });
      const second = createSession({
        projectPath: '/workspace/b',
        sessionId: 'shared-session',
        taskStatus: 'failed',
        taskCompletedAt: COMPLETED_AT,
        taskFailure: {
          code: 'runtime',
          message: 'failed',
          retryable: true,
        },
      });
      const original = ledger([entryFor(first), entryFor(second)]);

      const acknowledged = acknowledgeTaskTerminal(original, refFor(first), first);

      expect(acknowledged.entries.map((entry) => entry.key)).toEqual([
        keyFor(second),
        keyFor(first),
      ]);
      expect(original.entries.map((entry) => entry.key)).toEqual([
        keyFor(first),
        keyFor(second),
      ]);
    });

    it('protects active null and unread entries while keeping 1024 newest terminals', () => {
      const unreadSession = createSession({
        projectPath: '/workspace/unread',
        sessionId: 'unread',
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });
      const runningSession = createSession({
        projectPath: '/workspace/running',
        sessionId: 'running',
      });
      const terminalSessions = Array.from({ length: 1_026 }, (_, index) =>
        createSession({
          projectPath: `/workspace/terminal/${index}`,
          sessionId: `terminal-${index}`,
          taskStatus: 'completed',
          taskCompletedAt: COMPLETED_AT,
        })
      );
      const inputLedger = ledger([
        entryFor(unreadSession),
        entryFor(runningSession),
        ...terminalSessions.map(entryFor),
      ]);

      const compacted = pruneAndCompactTaskTerminalReadLedger({
        ledger: inputLedger,
        sessions: [unreadSession, runningSession, ...terminalSessions],
        unreadTaskKeys: [keyFor(unreadSession)],
      });
      const keys = compacted.entries.map((entry) => entry.key);

      expect(compacted.entries).toHaveLength(1_026);
      expect(keys.slice(0, 2)).toEqual([keyFor(unreadSession), keyFor(runningSession)]);
      expect(keys).not.toContain(
        sessionRefKey({
          projectPath: '/workspace/terminal/0',
          sessionId: 'terminal-0',
        })
      );
      expect(keys).not.toContain(
        sessionRefKey({
          projectPath: '/workspace/terminal/1',
          sessionId: 'terminal-1',
        })
      );
      expect(keys).toContain(
        sessionRefKey({
          projectPath: '/workspace/terminal/2',
          sessionId: 'terminal-2',
        })
      );
      expect(keys).toContain(
        sessionRefKey({
          projectPath: '/workspace/terminal/1025',
          sessionId: 'terminal-1025',
        })
      );
    });

    it('prunes absent refs and isolates the same session id by project path', () => {
      const workspaceA = createSession({
        projectPath: '/workspace/a',
        sessionId: 'shared-session',
      });
      const workspaceB = createSession({
        projectPath: '/workspace/b',
        sessionId: 'shared-session',
      });
      const missing = createSession({
        projectPath: '/workspace/missing',
        sessionId: 'shared-session',
      });

      const compacted = pruneAndCompactTaskTerminalReadLedger({
        ledger: ledger([entryFor(workspaceA), entryFor(workspaceB), entryFor(missing)]),
        sessions: [workspaceA, workspaceB],
        unreadTaskKeys: [],
      });

      expect(compacted.entries.map((entry) => entry.key)).toEqual([
        keyFor(workspaceA),
        keyFor(workspaceB),
      ]);
    });
  });

  describe('catalog reconciliation', () => {
    it('silently baselines a terminal session discovered for the first time', () => {
      const completed = createSession({
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });

      expect(
        reconcileTaskAttention({
          ledger: ledger(),
          unreadTaskKeys: [],
          sessions: [completed],
          currentSessionRef: null,
          documentVisible: true,
        })
      ).toEqual({
        ledger: ledger([entryFor(completed)]),
        unreadTaskKeys: [],
      });
    });

    it('recovers a missed terminal result from a known null baseline idempotently', () => {
      const running = createSession();
      const completed = createSession({
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });
      const baseline = reconcileTaskAttention({
        ledger: ledger(),
        unreadTaskKeys: [],
        sessions: [running],
        currentSessionRef: null,
        documentVisible: true,
      });

      expect(baseline).toEqual({
        ledger: ledger([{ key: keyFor(running), signature: null }]),
        unreadTaskKeys: [],
      });

      const recovered = reconcileTaskAttention({
        ledger: baseline.ledger,
        unreadTaskKeys: baseline.unreadTaskKeys,
        sessions: [completed],
        currentSessionRef: null,
        documentVisible: true,
      });

      expect(recovered).toEqual({
        ledger: baseline.ledger,
        unreadTaskKeys: [keyFor(completed)],
      });
      expect(
        reconcileTaskAttention({
          ledger: recovered.ledger,
          unreadTaskKeys: recovered.unreadTaskKeys,
          sessions: [completed],
          currentSessionRef: null,
          documentVisible: true,
        })
      ).toEqual(recovered);
    });

    it('retains a new terminal baseline as MRU so its next result becomes unread', () => {
      const acknowledgedSessions = Array.from({ length: 1_024 }, (_, index) =>
        createSession({
          projectPath: `/workspace/completed/${index}`,
          sessionId: `completed-${index}`,
          taskStatus: 'completed',
          taskCompletedAt: COMPLETED_AT,
        })
      );
      const fresh = createSession({
        projectPath: '/workspace/fresh',
        sessionId: 'fresh',
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });

      const first = reconcileTaskAttention({
        ledger: ledger(acknowledgedSessions.map(entryFor)),
        unreadTaskKeys: [],
        sessions: [...acknowledgedSessions, fresh],
        currentSessionRef: null,
        documentVisible: true,
      });

      expect(first.ledger.entries).toHaveLength(1_024);
      expect(first.ledger.entries.at(-1)).toEqual(entryFor(fresh));
      expect(first.ledger.entries.map((entry) => entry.key)).not.toContain(
        keyFor(acknowledgedSessions[0])
      );

      const freshNextResult = createSession({
        ...fresh,
        taskStatus: 'failed',
        taskCompletedAt: '2026-09-04T02:03:04.000Z',
        taskFailure: {
          code: 'network',
          message: 'network details',
          retryable: true,
        },
      });
      const second = reconcileTaskAttention({
        ledger: first.ledger,
        unreadTaskKeys: first.unreadTaskKeys,
        sessions: [...acknowledgedSessions, freshNextResult],
        currentSessionRef: null,
        documentVisible: true,
      });

      expect(second.unreadTaskKeys).toEqual([keyFor(freshNextResult)]);
      expect(
        second.ledger.entries.find((entry) => entry.key === keyFor(freshNextResult))
      ).toEqual(entryFor(fresh));
    });

    it('acknowledges the visible current terminal session and clears stale unread', () => {
      const completed = createSession({
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });

      expect(
        reconcileTaskAttention({
          ledger: ledger([{ key: keyFor(completed), signature: null }]),
          unreadTaskKeys: [keyFor(completed)],
          sessions: [completed],
          currentSessionRef: refFor(completed),
          documentVisible: true,
        })
      ).toEqual({
        ledger: ledger([entryFor(completed)]),
        unreadTaskKeys: [],
      });
    });

    it('keeps attention isolated across equal session ids in different projects', () => {
      const workspaceA = createSession({
        projectPath: '/workspace/a',
        sessionId: 'shared-session',
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });
      const workspaceB = createSession({
        projectPath: '/workspace/b',
        sessionId: 'shared-session',
        taskStatus: 'completed',
        taskCompletedAt: COMPLETED_AT,
      });

      const reconciled = reconcileTaskAttention({
        ledger: ledger([
          { key: keyFor(workspaceA), signature: null },
          entryFor(workspaceB),
        ]),
        unreadTaskKeys: [],
        sessions: [workspaceA, workspaceB],
        currentSessionRef: refFor(workspaceB),
        documentVisible: true,
      });

      expect(reconciled.unreadTaskKeys).toEqual([keyFor(workspaceA)]);
      expect(reconciled.ledger.entries).toEqual([
        { key: keyFor(workspaceA), signature: null },
        entryFor(workspaceB),
      ]);
    });
  });
});
