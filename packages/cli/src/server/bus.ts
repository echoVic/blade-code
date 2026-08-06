import { EventEmitter } from 'events';
import type { SessionRef } from './sessionRef.js';
import { normalizeSessionRef } from './sessionRef.js';

export interface BusEvent {
  sessionId: string;
  projectPath: string;
  type: string;
  /**
   * Monotonic sequence number for durable committed events (from SessionEventLog).
   * Absent for ephemeral events (streaming deltas, heartbeats, transient signals),
   * which must not advance a consumer's Last-Event-ID cursor.
   */
  seq?: number;
  properties: Record<string, unknown>;
}

class GlobalBus extends EventEmitter {
  private static instance: GlobalBus;

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  static getInstance(): GlobalBus {
    if (!GlobalBus.instance) {
      GlobalBus.instance = new GlobalBus();
    }
    return GlobalBus.instance;
  }

  publish(
    ref: SessionRef,
    type: string,
    properties: Record<string, unknown>,
    seq?: number
  ) {
    const normalizedRef = normalizeSessionRef(ref);
    this.emit('event', {
      sessionId: normalizedRef.sessionId,
      projectPath: normalizedRef.projectPath,
      type,
      ...(seq !== undefined ? { seq } : {}),
      properties,
    } satisfies BusEvent);
  }

  subscribe(callback: (event: BusEvent) => void) {
    this.on('event', callback);
    return () => this.off('event', callback);
  }
}

export const Bus = GlobalBus.getInstance();
