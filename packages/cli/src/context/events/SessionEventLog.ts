import type { FileHandle } from 'node:fs/promises';
import {
  assertAcpRemoteSessionTranscriptIdentity,
  assertAcpRemoteStateFileHandle,
} from '../../acp/AcpRemoteWorkspace.js';
import { Bus } from '../../server/bus.js';
import { JSONLStore } from '../storage/JSONLStore.js';
import {
  createSessionStateStorage,
  type SessionStateStorage,
  sessionStateStorageKey,
  withSessionStatePaths,
} from '../storage/SessionStateStorage.js';
import { isTokenBudgetHandoffEvent } from '../TokenBudgetHandoff.js';
import type { SessionEvent } from '../types.js';
import type { EphemeralDelta } from './EphemeralDelta.js';

export const MAX_CACHED_SESSION_EVENT_LOGS = 256;

/**
 * A subscriber over the unified session stream. Receives durable committed
 * events (carrying a monotonic `seq`) and ephemeral in-flight deltas.
 */
export interface SessionStreamSubscriber {
  onCommitted(event: SessionEvent): void | Promise<void>;
  onDelta?(delta: EphemeralDelta): void;
}

export interface SubscribeOptions {
  /**
   * Replay committed events with `seq >= fromSeq` before live delivery.
   * Backed by the JSONL transcript, the authoritative committed history.
   */
  fromSeq?: number;
}

/**
 * SessionEventLog — the single writer and fan-out authority for one session's
 * event stream. All durable writes flow through {@link commit}, which delegates
 * seq assignment + persistence to {@link JSONLStore} (inside its per-file write
 * lock) and then fans the stamped event out to every subscriber. Ephemeral
 * deltas ({@link emitDelta}) are fanned out only — never persisted, never
 * assigned a seq — so the JSONL transcript stays the pure committed truth.
 *
 * Persistence and fan-out are now atomically coupled: a committed event is on
 * disk before any subscriber (CLI store, Web SSE, ACP) observes it.
 */
export class SessionEventLog {
  private static readonly instances = new Map<string, SessionEventLog>();

  private readonly subscribers = new Set<SessionStreamSubscriber>();
  private highestSeq = 0;

  private constructor(
    readonly sessionId: string,
    readonly projectPath: string,
    private readonly storage: SessionStateStorage
  ) {}

  /**
   * Returns the shared log for a session, keyed by project + session so every
   * mode (CLI/Web/ACP) in one process observes the same ordering authority.
   */
  static for(
    sessionId: string,
    projectPath: string,
    storage: SessionStateStorage = createSessionStateStorage(projectPath)
  ): SessionEventLog {
    const key = sessionStateStorageKey(storage, sessionId);
    let log = SessionEventLog.instances.get(key);
    if (!log) {
      log = new SessionEventLog(sessionId, projectPath, storage);
      SessionEventLog.instances.set(key, log);
      SessionEventLog.pruneIdleInstances(key);
    } else {
      SessionEventLog.instances.delete(key);
      SessionEventLog.instances.set(key, log);
    }
    return log;
  }

  /** Test/GC seam: drop the cached instance for a session. */
  static release(
    sessionId: string,
    projectPath: string,
    storage: SessionStateStorage = createSessionStateStorage(projectPath)
  ): void {
    SessionEventLog.instances.delete(sessionStateStorageKey(storage, sessionId));
  }

  private static pruneIdleInstances(preservedKey?: string): void {
    if (SessionEventLog.instances.size <= MAX_CACHED_SESSION_EVENT_LOGS) return;

    for (const [key, log] of SessionEventLog.instances) {
      if (key === preservedKey || log.subscribers.size > 0) continue;
      SessionEventLog.instances.delete(key);
      if (SessionEventLog.instances.size <= MAX_CACHED_SESSION_EVENT_LOGS) return;
    }
  }

  /** Highest committed seq observed by this log instance. */
  get lastSeq(): number {
    return this.highestSeq;
  }

  async readAll(): Promise<SessionEvent[]> {
    return this.withStore(async (store, options, validateEntries) => {
      const entries = options
        ? await store.readAllValidated(options)
        : await store.readAll();
      validateEntries(entries);
      return entries;
    });
  }

  /** Persist a single event, then fan it out. Returns the stamped event. */
  async commit(event: SessionEvent): Promise<SessionEvent> {
    const [stamped] = await this.commitEntries([event]);
    this.record(stamped);
    return stamped;
  }

  /** Persist a batch atomically (one per-file lock), then fan each out in order. */
  async commitBatch(events: SessionEvent[]): Promise<SessionEvent[]> {
    if (events.length === 0) return [];
    const stamped = await this.commitEntries(events);
    for (const event of stamped) this.record(event);
    return stamped;
  }

  /**
   * Persist one event after validating the latest committed transcript under
   * the same per-file lock. This is used for single-winner durable decisions.
   */
  async commitValidated(
    buildEvent: (events: readonly SessionEvent[]) => SessionEvent
  ): Promise<SessionEvent> {
    const stamped = await this.withStore((store, options, validateEntries) =>
      store.appendValidated((events) => {
        validateEntries(events);
        return buildEvent(events);
      }, options)
    );
    this.record(stamped);
    return stamped;
  }

  /** Validate latest committed state and persist one ordered recovery batch. */
  async commitValidatedBatch(
    buildEvents: (events: readonly SessionEvent[]) => SessionEvent[]
  ): Promise<SessionEvent[]> {
    const stamped = await this.withStore((store, options, validateEntries) =>
      store.appendValidatedBatch((events) => {
        validateEntries(events);
        return buildEvents(events);
      }, options)
    );
    for (const event of stamped) this.record(event);
    return stamped;
  }

  /** Fan out an ephemeral delta. Not persisted, not sequenced. */
  emitDelta(delta: EphemeralDelta): void {
    for (const subscriber of this.subscribers) {
      subscriber.onDelta?.(delta);
    }
    // Ephemeral fan-out onto the Bus WITHOUT a seq, so it never advances a
    // consumer's Last-Event-ID cursor. Deltas are never replayed on reconnect.
    Bus.publish({ sessionId: this.sessionId, projectPath: this.projectPath }, 'delta', {
      delta,
    });
  }

  /**
   * Subscribe to the stream. With {@link SubscribeOptions.fromSeq}, committed
   * events at or after the cursor are replayed before live delivery.
   */
  subscribe(
    subscriber: SessionStreamSubscriber,
    options?: SubscribeOptions
  ): () => void {
    this.subscribers.add(subscriber);
    if (options?.fromSeq !== undefined) {
      void this.replay(subscriber, options.fromSeq);
    }
    return () => {
      this.subscribers.delete(subscriber);
      SessionEventLog.pruneIdleInstances();
    };
  }

  /**
   * Replay committed events with `seq >= fromSeq`. Reads from the JSONL
   * transcript, which is the authoritative committed history and includes
   * events written by paths other than this log (e.g. session metadata). seq
   * is guaranteed by JSONLStore/parseSessionJSONL.
   */
  async replay(subscriber: SessionStreamSubscriber, fromSeq: number): Promise<void> {
    const source = await this.withStore(async (store, options, validateEntries) => {
      const entries = options
        ? await store.readAllValidated(options)
        : await store.readAll();
      validateEntries(entries);
      return entries.filter((entry) => (entry.seq ?? 0) >= fromSeq);
    });
    for (const event of source) {
      if (isTokenBudgetHandoffEvent(event)) continue;
      await subscriber.onCommitted(event);
    }
  }

  private record(event: SessionEvent): void {
    if (typeof event.seq === 'number' && event.seq > this.highestSeq) {
      this.highestSeq = event.seq;
    }
    if (isTokenBudgetHandoffEvent(event)) {
      return;
    }
    for (const subscriber of this.subscribers) {
      const observed = subscriber.onCommitted(event);
      if (observed) void Promise.resolve(observed).catch(() => undefined);
    }
    // Fan the committed event onto the global Bus so cross-cutting consumers
    // (Web SSE, ACP) observe it with its seq. The Bus is the log's fan-out
    // channel, not an independent event system.
    Bus.publish(
      { sessionId: this.sessionId, projectPath: this.projectPath },
      `committed.${event.type}`,
      { event },
      event.seq
    );
  }

  private commitEntries(events: SessionEvent[]): Promise<SessionEvent[]> {
    return this.withStore((store, options, validateEntries) =>
      options
        ? store.appendValidatedBatch((entries) => {
            validateEntries(entries);
            return events;
          }, options)
        : store.appendBatch(events)
    );
  }

  private withStore<T>(
    operation: (
      store: JSONLStore,
      options:
        | {
            noFollow: true;
            validateHandle: (handle: FileHandle) => Promise<void>;
          }
        | undefined,
      validateEntries: (entries: readonly SessionEvent[]) => void
    ) => Promise<T>
  ): Promise<T> {
    return withSessionStatePaths(this.storage, this.sessionId, async (paths) => {
      const store = new JSONLStore(paths.transcriptPath);
      if (!paths.remoteScope) return operation(store, undefined, () => undefined);
      const scope = paths.remoteScope;
      const validateHandle = async (handle: FileHandle): Promise<void> => {
        await assertAcpRemoteStateFileHandle(scope, paths.transcriptPath, handle);
      };
      const validateEntries = (entries: readonly SessionEvent[]): void => {
        assertAcpRemoteSessionTranscriptIdentity(
          entries,
          this.sessionId,
          this.projectPath,
          this.storage.kind === 'acp-remote' ? this.storage.descriptor : undefined
        );
      };
      return operation(store, { noFollow: true, validateHandle }, validateEntries);
    });
  }
}
