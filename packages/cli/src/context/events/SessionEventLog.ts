import { getSessionFilePath } from '../storage/pathUtils.js';
import { JSONLStore } from '../storage/JSONLStore.js';
import { Bus } from '../../server/bus.js';
import type { SessionEvent } from '../types.js';
import type { EphemeralDelta } from './EphemeralDelta.js';

/**
 * A subscriber over the unified session stream. Receives durable committed
 * events (carrying a monotonic `seq`) and ephemeral in-flight deltas.
 */
export interface SessionStreamSubscriber {
  onCommitted(event: SessionEvent): void;
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

  private readonly store: JSONLStore;
  private readonly subscribers = new Set<SessionStreamSubscriber>();
  private highestSeq = 0;

  private constructor(
    readonly sessionId: string,
    readonly projectPath: string
  ) {
    this.store = new JSONLStore(getSessionFilePath(projectPath, sessionId));
  }

  /**
   * Returns the shared log for a session, keyed by project + session so every
   * mode (CLI/Web/ACP) in one process observes the same ordering authority.
   */
  static for(sessionId: string, projectPath: string): SessionEventLog {
    const key = `${projectPath}\u0000${sessionId}`;
    let log = SessionEventLog.instances.get(key);
    if (!log) {
      log = new SessionEventLog(sessionId, projectPath);
      SessionEventLog.instances.set(key, log);
    }
    return log;
  }

  /** Test/GC seam: drop the cached instance for a session. */
  static release(sessionId: string, projectPath: string): void {
    SessionEventLog.instances.delete(`${projectPath}\u0000${sessionId}`);
  }

  /** Highest committed seq observed by this log instance. */
  get lastSeq(): number {
    return this.highestSeq;
  }

  /** Persist a single event, then fan it out. Returns the stamped event. */
  async commit(event: SessionEvent): Promise<SessionEvent> {
    const stamped = await this.store.append(event);
    this.record(stamped);
    return stamped;
  }

  /** Persist a batch atomically (one per-file lock), then fan each out in order. */
  async commitBatch(events: SessionEvent[]): Promise<SessionEvent[]> {
    if (events.length === 0) return [];
    const stamped = await this.store.appendBatch(events);
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
    Bus.publish(
      { sessionId: this.sessionId, projectPath: this.projectPath },
      'delta',
      { delta }
    );
  }

  /**
   * Subscribe to the stream. With {@link SubscribeOptions.fromSeq}, committed
   * events at or after the cursor are replayed before live delivery.
   */
  subscribe(subscriber: SessionStreamSubscriber, options?: SubscribeOptions): () => void {
    this.subscribers.add(subscriber);
    if (options?.fromSeq !== undefined) {
      void this.replay(subscriber, options.fromSeq);
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Replay committed events with `seq >= fromSeq`. Reads from the JSONL
   * transcript, which is the authoritative committed history and includes
   * events written by paths other than this log (e.g. session metadata). seq
   * is guaranteed by JSONLStore/parseSessionJSONL.
   */
  async replay(subscriber: SessionStreamSubscriber, fromSeq: number): Promise<void> {
    const source = await this.store.readFromSeq(fromSeq);
    for (const event of source) {
      subscriber.onCommitted(event);
    }
  }

  private record(event: SessionEvent): void {
    if (typeof event.seq === 'number' && event.seq > this.highestSeq) {
      this.highestSeq = event.seq;
    }
    for (const subscriber of this.subscribers) {
      subscriber.onCommitted(event);
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
}
