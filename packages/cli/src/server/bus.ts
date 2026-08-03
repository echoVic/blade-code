import { EventEmitter } from 'events';
import type { SessionRef } from './sessionRef.js';

export interface BusEvent {
  sessionId: string;
  projectPath: string;
  type: string;
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

  publish(ref: SessionRef, type: string, properties: Record<string, unknown>) {
    this.emit('event', {
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
      type,
      properties,
    } satisfies BusEvent);
  }

  subscribe(callback: (event: BusEvent) => void) {
    this.on('event', callback);
    return () => this.off('event', callback);
  }
}

export const Bus = GlobalBus.getInstance();
