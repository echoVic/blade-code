import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../types.js';

export const MAX_PENDING_STEERS = 20;
export const MAX_PENDING_STEER_CHARS = 5_000_000;

export interface SteeringMessage {
  id: string;
  content: UserMessageContent;
  queuedAt: number;
}

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
  private pending: SteeringMessage[] = [];

  beginTurn(): ActiveTurnHandle {
    if (this.activeTurn) {
      throw new Error(`Session already has an active turn: ${this.activeTurn.id}`);
    }

    const handle = { id: nanoid(12) };
    this.activeTurn = { id: handle.id, sealed: false };
    return handle;
  }

  enqueue(
    content: UserMessageContent,
    options: { allowBeforeTurn?: boolean } = {}
  ): SteeringEnqueueResult {
    if (!this.activeTurn && !options.allowBeforeTurn) {
      return {
        accepted: false,
        queued: this.pending.length,
        reason: 'no_active_turn',
      };
    }
    if (this.activeTurn?.sealed) {
      return {
        accepted: false,
        turnId: this.activeTurn.id,
        queued: this.pending.length,
        reason: 'turn_sealed',
      };
    }

    const pendingChars = this.pending.reduce(
      (total, message) => total + getSteeringContentSize(message.content),
      0
    );
    if (
      this.pending.length >= MAX_PENDING_STEERS ||
      pendingChars + getSteeringContentSize(content) > MAX_PENDING_STEER_CHARS
    ) {
      return {
        accepted: false,
        turnId: this.activeTurn?.id,
        queued: this.pending.length,
        reason: 'queue_full',
      };
    }

    this.pending.push({
      id: nanoid(12),
      content,
      queuedAt: Date.now(),
    });
    return {
      accepted: true,
      turnId: this.activeTurn?.id,
      queued: this.pending.length,
    };
  }

  drain(handle: ActiveTurnHandle): SteeringMessage[] {
    this.assertOwner(handle);
    const messages = this.pending;
    this.pending = [];
    return messages;
  }

  drainOrSeal(handle: ActiveTurnHandle): {
    messages: SteeringMessage[];
    sealed: boolean;
  } {
    this.assertOwner(handle);
    if (this.pending.length > 0) {
      return { messages: this.drain(handle), sealed: false };
    }

    this.activeTurn!.sealed = true;
    return { messages: [], sealed: true };
  }

  endTurn(handle: ActiveTurnHandle, options: { preservePending?: boolean } = {}): void {
    this.assertOwner(handle);
    this.activeTurn = undefined;
    if (!options.preservePending) {
      this.pending = [];
    }
  }

  isActive(): boolean {
    return Boolean(this.activeTurn && !this.activeTurn.sealed);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private assertOwner(handle: ActiveTurnHandle): void {
    if (!this.activeTurn || this.activeTurn.id !== handle.id) {
      throw new Error(`Turn ${handle.id} does not own this session mailbox`);
    }
  }
}
