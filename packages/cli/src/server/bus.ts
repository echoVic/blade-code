import { EventEmitter } from 'events';

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

  publish(sessionId: string, type: string, properties: Record<string, unknown>) {
    this.emit('event', { sessionId, type, properties });
  }

  subscribe(callback: (event: { sessionId: string; type: string; properties: Record<string, unknown> }) => void) {
    this.on('event', callback);
    return () => this.off('event', callback);
  }
}

export const Bus = GlobalBus.getInstance();
