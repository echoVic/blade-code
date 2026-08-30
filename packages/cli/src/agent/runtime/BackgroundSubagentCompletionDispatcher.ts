import {
  normalizeAgentSessionOwner,
  type AgentSessionOwner,
} from '../subagents/AgentSessionStore.js';
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { sessionRefKey } from '../../server/sessionRef.js';
import { KeyedMutexRegistry } from '../../utils/KeyedMutexRegistry.js';

export interface BackgroundSubagentCompletionSink {
  reconcile(agentId?: string): Promise<void>;
}

export interface Registration {
  dispose(): Promise<void>;
}

export type DispatchResult = 'delivered' | 'deferred';

interface SinkRegistration {
  readonly token: symbol;
  readonly sink: BackgroundSubagentCompletionSink;
}

export class BackgroundSubagentCompletionDispatcher {
  private readonly registrations = new Map<string, SinkRegistration>();
  private readonly ownerMutexes = new KeyedMutexRegistry<string>();

  async attach(
    owner: AgentSessionOwner,
    sink: BackgroundSubagentCompletionSink
  ): Promise<Registration> {
    const ownerKey = this.getOwnerKey(owner);
    const token = Symbol(ownerKey);

    await this.ownerMutexes.runExclusive(ownerKey, async () => {
      if (this.registrations.has(ownerKey)) {
        throw new Error('Background completion sink already attached');
      }

      this.registrations.set(ownerKey, { token, sink });
      try {
        await sink.reconcile();
      } catch (error) {
        const current = this.registrations.get(ownerKey);
        if (current?.token === token) {
          this.registrations.delete(ownerKey);
        }
        throw error;
      }
    });

    return {
      dispose: async () => {
        await this.ownerMutexes.runExclusive(ownerKey, async () => {
          const current = this.registrations.get(ownerKey);
          if (current?.token === token) {
            this.registrations.delete(ownerKey);
          }
        });
      },
    };
  }

  async dispatch(
    owner: AgentSessionOwner,
    agentId: string
  ): Promise<DispatchResult> {
    assertValidSessionId(agentId);
    const ownerKey = this.getOwnerKey(owner);

    return this.ownerMutexes.runExclusive(ownerKey, async () => {
      const current = this.registrations.get(ownerKey);
      if (!current) {
        return 'deferred';
      }

      await current.sink.reconcile(agentId);
      return 'delivered';
    });
  }

  getStats(): {
    registrations: number;
    activeOwnerOperations: number;
  } {
    return {
      registrations: this.registrations.size,
      activeOwnerOperations: this.ownerMutexes.getStats().operations,
    };
  }

  private getOwnerKey(owner: AgentSessionOwner): string {
    return sessionRefKey(normalizeAgentSessionOwner(owner));
  }
}

export const backgroundSubagentCompletionDispatcher =
  new BackgroundSubagentCompletionDispatcher();
