import { AsyncLocalStorage } from 'node:async_hooks';
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { sessionRefKey } from '../../server/sessionRef.js';
import { KeyedMutexRegistry } from '../../utils/KeyedMutexRegistry.js';
import {
  type AgentSessionOwner,
  normalizeAgentSessionOwner,
} from '../subagents/AgentSessionStore.js';

export interface BackgroundSubagentCompletionSink {
  reconcile(agentId?: string): Promise<void>;
}

export interface BackgroundSubagentCompletionRegistration {
  dispose(): Promise<void>;
}

export type BackgroundSubagentCompletionDispatchResult = 'delivered' | 'deferred';

export class BackgroundSubagentCompletionReentrancyError extends Error {
  readonly ownerKey: string;

  constructor(ownerKey: string) {
    super(`Reentrant background completion operation rejected for owner ${ownerKey}`);
    this.name = 'BackgroundSubagentCompletionReentrancyError';
    this.ownerKey = ownerKey;
  }
}

interface SinkRegistration {
  readonly token: symbol;
  readonly sink: BackgroundSubagentCompletionSink;
}

export class BackgroundSubagentCompletionDispatcher {
  private readonly registrations = new Map<string, SinkRegistration>();
  private readonly ownerMutexes = new KeyedMutexRegistry<string>();
  private readonly ownerContext = new AsyncLocalStorage<ReadonlySet<string>>();

  async attach(
    owner: AgentSessionOwner,
    sink: BackgroundSubagentCompletionSink
  ): Promise<BackgroundSubagentCompletionRegistration> {
    const ownerKey = this.getOwnerKey(owner);
    const token = Symbol(ownerKey);

    this.assertNotReentrant(ownerKey);
    await this.ownerMutexes.runExclusive(ownerKey, async () => {
      if (this.registrations.has(ownerKey)) {
        throw new Error('Background completion sink already attached');
      }

      this.registrations.set(ownerKey, { token, sink });
      try {
        await this.runWithOwnerContext(ownerKey, () => sink.reconcile());
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
        this.assertNotReentrant(ownerKey);
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
  ): Promise<BackgroundSubagentCompletionDispatchResult> {
    assertValidSessionId(agentId);
    const ownerKey = this.getOwnerKey(owner);

    this.assertNotReentrant(ownerKey);
    return this.ownerMutexes.runExclusive(ownerKey, async () => {
      const current = this.registrations.get(ownerKey);
      if (!current) {
        return 'deferred';
      }

      await this.runWithOwnerContext(ownerKey, () => current.sink.reconcile(agentId));
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

  private assertNotReentrant(ownerKey: string): void {
    if (this.ownerContext.getStore()?.has(ownerKey)) {
      throw new BackgroundSubagentCompletionReentrancyError(ownerKey);
    }
  }

  private runWithOwnerContext<T>(
    ownerKey: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const inheritedOwners = this.ownerContext.getStore() ?? new Set<string>();
    const nextOwners = new Set(inheritedOwners);
    nextOwners.add(ownerKey);
    return this.ownerContext.run(nextOwners, operation);
  }
}

export const backgroundSubagentCompletionDispatcher =
  new BackgroundSubagentCompletionDispatcher();
