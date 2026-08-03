import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../types.js';
import {
  DurableSteeringInbox,
  type DurableSteeringMessage,
} from './DurableSteeringInbox.js';

export const MAX_PENDING_STEERS = 20;
export const MAX_PENDING_STEER_CHARS = 5_000_000;

export type SteeringMessage = DurableSteeringMessage;

export interface SteeringEnqueueResult {
  accepted: boolean;
  turnId?: string;
  queued: number;
  reason?: 'no_active_turn' | 'turn_sealed' | 'queue_full';
}

export interface ActiveTurnHandle {
  id: string;
}

interface ActiveTurnState {
  id: string;
  sealed: boolean;
}

export function getSteeringContentSize(content: UserMessageContent): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((total, part) => {
    if (part.type === 'text') return total + part.text.length;
    return total + part.image_url.url.length;
  }, 0);
}

export class ActiveTurnMailbox {
  private activeTurn?: ActiveTurnState;
  private claimed = new Map<string, SteeringMessage>();

  private constructor(private readonly inbox: DurableSteeringInbox) {}

  static async create(
    workspaceRoot: string,
    sessionId: string
  ): Promise<ActiveTurnMailbox> {
    return new ActiveTurnMailbox(
      await DurableSteeringInbox.open(workspaceRoot, sessionId)
    );
  }

  beginTurn(): ActiveTurnHandle {
    if (this.activeTurn) {
      throw new Error(`Session already has an active turn: ${this.activeTurn.id}`);
    }

    const handle = { id: nanoid(12) };
    this.activeTurn = { id: handle.id, sealed: false };
    return handle;
  }

  async enqueue(
    content: UserMessageContent,
    options: { allowBeforeTurn?: boolean } = {}
  ): Promise<SteeringEnqueueResult> {
    if (!this.activeTurn && !options.allowBeforeTurn) {
      return {
        accepted: false,
        queued: this.inbox.count(),
        reason: 'no_active_turn',
      };
    }
    if (this.activeTurn?.sealed) {
      return {
        accepted: false,
        turnId: this.activeTurn.id,
        queued: this.inbox.count(),
        reason: 'turn_sealed',
      };
    }

    const accepted = await this.inbox.enqueue(
      {
        id: nanoid(12),
        content,
        queuedAt: Date.now(),
      },
      (pending) =>
        pending.length < MAX_PENDING_STEERS &&
        pending.reduce(
          (total, message) => total + getSteeringContentSize(message.content),
          getSteeringContentSize(content)
        ) <= MAX_PENDING_STEER_CHARS
    );
    if (!accepted) {
      return {
        accepted: false,
        turnId: this.activeTurn?.id,
        queued: this.inbox.count(),
        reason: 'queue_full',
      };
    }
    return {
      accepted: true,
      turnId: this.activeTurn?.id,
      queued: this.inbox.count(),
    };
  }

  drain(handle: ActiveTurnHandle): SteeringMessage[] {
    this.assertOwner(handle);
    const messages = this.inbox
      .list()
      .filter((message) => !this.claimed.has(message.id));
    for (const message of messages) {
      this.claimed.set(message.id, message);
    }
    return messages;
  }

  drainOrSeal(handle: ActiveTurnHandle): {
    messages: SteeringMessage[];
    sealed: boolean;
  } {
    this.assertOwner(handle);
    if (this.inbox.count() > this.claimed.size) {
      return { messages: this.drain(handle), sealed: false };
    }

    this.activeTurn!.sealed = true;
    return { messages: [], sealed: true };
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    await this.inbox.acknowledge(ids);
    for (const id of ids) {
      this.claimed.delete(id);
    }
  }

  endTurn(handle: ActiveTurnHandle): void {
    this.assertOwner(handle);
    this.activeTurn = undefined;
    this.claimed.clear();
  }

  isActive(): boolean {
    return Boolean(this.activeTurn && !this.activeTurn.sealed);
  }

  pendingCount(): number {
    return this.inbox.count();
  }

  recoveredCount(): number {
    return this.inbox.recoveredCount();
  }

  private assertOwner(handle: ActiveTurnHandle): void {
    if (!this.activeTurn || this.activeTurn.id !== handle.id) {
      throw new Error(`Turn ${handle.id} does not own this session mailbox`);
    }
  }
}
