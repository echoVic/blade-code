import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../../api/attachmentLimits.js';
import type { MessagePersistenceMetadata } from '../../context/types.js';
import type { JsonObject } from '../../store/types.js';
import type { BackgroundSubagentCompletion } from '../subagents/BackgroundSubagentCompletion.js';
import type { UserMessageContent } from '../types.js';
import {
  DurableSteeringInbox,
  type DurableSteeringMessage,
} from './DurableSteeringInbox.js';

export const MAX_PENDING_STEERS = 20;
export const MAX_PENDING_BACKGROUND_COMPLETIONS = 100;
export const MAX_PENDING_STEER_CHARS =
  MAX_INLINE_ATTACHMENT_BYTES + MAX_USER_MESSAGE_TEXT_CHARS;
const MAX_PENDING_BACKGROUND_COMPLETION_CHARS = 7 * 1024 * 1024;

export type SteeringMessage = DurableSteeringMessage;

export interface SteeringEnqueueResult {
  accepted: boolean;
  messageId?: string;
  turnId?: string;
  queued: number;
  reason?: 'no_active_turn' | 'turn_sealed' | 'queue_full';
  delivery?: 'current_turn' | 'next_turn';
  duplicate?: boolean;
}

export interface ActiveTurnHandle {
  id: string;
}

export interface PreparedInputTurn {
  handle: ActiveTurnHandle;
  messageId: string;
  queued: number;
  mode: 'direct' | 'pending';
  content?: UserMessageContent;
  metadata?: MessagePersistenceMetadata;
}

export type InputTurnPreparation =
  | ({ accepted: true } & PreparedInputTurn)
  | {
      accepted: false;
      queued: number;
      reason: 'turn_active' | 'queue_full';
    };

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

function getOutputSchemaSize(outputSchema: JsonObject | undefined): number {
  return outputSchema ? Buffer.byteLength(JSON.stringify(outputSchema)) : 0;
}

function getMetadataSize(metadata: MessagePersistenceMetadata | undefined): number {
  return metadata ? Buffer.byteLength(JSON.stringify(metadata)) : 0;
}

export class ActiveTurnMailbox {
  private readonly transitionMutex = new Mutex();
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

    return this.createTurn();
  }

  async enqueue(
    content: UserMessageContent,
    options: {
      allowBeforeTurn?: boolean;
      messageId?: string;
      persisted?: boolean;
      outputSchema?: JsonObject;
      origin?: SteeringMessage['origin'];
      metadata?: MessagePersistenceMetadata;
    } = {}
  ): Promise<SteeringEnqueueResult> {
    return this.transitionMutex.runExclusive(async () => {
      if (!this.activeTurn && !options.allowBeforeTurn) {
        return {
          accepted: false,
          queued: this.inbox.count(),
          reason: 'no_active_turn',
        };
      }

      const delivery =
        this.activeTurn && !this.activeTurn.sealed
          ? ('current_turn' as const)
          : ('next_turn' as const);
      return this.enqueueDurably(content, delivery, options);
    });
  }

  async enqueueBackgroundSubagentCompletion(
    completion: BackgroundSubagentCompletion
  ): Promise<SteeringEnqueueResult> {
    return this.transitionMutex.runExclusive(async () => {
      const delivery =
        this.activeTurn && !this.activeTurn.sealed
          ? ('current_turn' as const)
          : ('next_turn' as const);
      return this.enqueueDurably(completion.content, delivery, {
        messageId: completion.inboxMessageId,
        persisted: true,
        origin: 'background_subagent',
        metadata: completion.metadata,
      });
    });
  }

  async prepareInputTurn(
    content: UserMessageContent,
    options: {
      outputSchema?: JsonObject;
      metadata?: MessagePersistenceMetadata;
    } = {}
  ): Promise<InputTurnPreparation> {
    return this.transitionMutex.runExclusive(async () => {
      if (this.activeTurn) {
        return {
          accepted: false,
          queued: this.inbox.count(),
          reason: 'turn_active',
        };
      }

      const hadPendingInput = this.inbox.count() > 0;
      const queued = await this.enqueueDurably(content, 'next_turn', options);
      if (!queued.accepted || !queued.messageId) {
        return {
          accepted: false,
          queued: queued.queued,
          reason: 'queue_full',
        };
      }

      const handle = this.createTurn();
      if (!hadPendingInput) {
        const message = this.inbox
          .list()
          .find((candidate) => candidate.id === queued.messageId);
        if (!message) {
          this.activeTurn = undefined;
          throw new Error(`Prepared input disappeared from inbox: ${queued.messageId}`);
        }
        this.claimed.set(message.id, message);
      }

      return {
        accepted: true,
        handle,
        messageId: queued.messageId,
        queued: queued.queued,
        mode: hadPendingInput ? 'pending' : 'direct',
        content,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      };
    });
  }

  async drain(handle: ActiveTurnHandle): Promise<SteeringMessage[]> {
    return this.transitionMutex.runExclusive(() => {
      this.assertOwner(handle);
      const messages = this.inbox
        .list()
        .filter((message) => !this.claimed.has(message.id));
      for (const message of messages) {
        this.claimed.set(message.id, message);
      }
      return messages;
    });
  }

  async drainOrSeal(handle: ActiveTurnHandle): Promise<{
    messages: SteeringMessage[];
    sealed: boolean;
  }> {
    return this.transitionMutex.runExclusive(() => {
      this.assertOwner(handle);
      if (this.inbox.count() > this.claimed.size) {
        const messages = this.inbox
          .list()
          .filter((message) => !this.claimed.has(message.id));
        for (const message of messages) {
          this.claimed.set(message.id, message);
        }
        return { messages, sealed: false };
      }

      this.activeTurn!.sealed = true;
      return { messages: [], sealed: true };
    });
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    await this.inbox.acknowledge(ids);
    for (const id of ids) {
      this.claimed.delete(id);
    }
  }

  async claimedMessageIds(handle: ActiveTurnHandle): Promise<string[]> {
    return this.transitionMutex.runExclusive(() => {
      this.assertOwner(handle);
      return [...this.claimed.keys()];
    });
  }

  async finishTurn(
    handle: ActiveTurnHandle,
    options: { continuePending?: boolean } = {}
  ): Promise<ActiveTurnHandle | undefined> {
    return this.transitionMutex.runExclusive(() => {
      this.assertOwner(handle);
      this.activeTurn = undefined;
      this.claimed.clear();
      if (!options.continuePending || this.inbox.count() === 0) {
        return undefined;
      }

      return this.createTurn();
    });
  }

  async beginPendingTurn(): Promise<ActiveTurnHandle | undefined> {
    return this.transitionMutex.runExclusive(() => {
      if (this.activeTurn || this.inbox.count() === 0) {
        return undefined;
      }
      return this.createTurn();
    });
  }

  isActive(): boolean {
    return Boolean(this.activeTurn && !this.activeTurn.sealed);
  }

  hasTurnOwner(): boolean {
    return Boolean(this.activeTurn);
  }

  pendingCount(): number {
    return this.inbox.count();
  }

  pendingMessages(): SteeringMessage[] {
    return this.inbox.list();
  }

  recoveredCount(): number {
    return this.inbox.recoveredCount();
  }

  private assertOwner(handle: ActiveTurnHandle): void {
    if (!this.activeTurn || this.activeTurn.id !== handle.id) {
      throw new Error(`Turn ${handle.id} does not own this session mailbox`);
    }
  }

  private async enqueueDurably(
    content: UserMessageContent,
    delivery: 'current_turn' | 'next_turn',
    options: {
      messageId?: string;
      persisted?: boolean;
      outputSchema?: JsonObject;
      origin?: SteeringMessage['origin'];
      metadata?: MessagePersistenceMetadata;
    } = {}
  ): Promise<SteeringEnqueueResult> {
    const existing = this.inbox
      .list()
      .find((candidate) => candidate.id === options.messageId);
    if (existing) {
      return {
        accepted: true,
        messageId: existing.id,
        turnId: this.activeTurn?.id,
        queued: this.inbox.count(),
        delivery,
        duplicate: true,
      };
    }
    const message = {
      id: options.messageId ?? nanoid(12),
      content,
      queuedAt: Date.now(),
      ...(options.persisted ? { persisted: true } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const accepted = await this.inbox.enqueue(message, (pending) => {
      const origin = options.origin ?? 'user';
      const sameOrigin = pending.filter(
        (candidate) => (candidate.origin ?? 'user') === origin
      );
      const maxCount =
        origin === 'background_subagent'
          ? MAX_PENDING_BACKGROUND_COMPLETIONS
          : MAX_PENDING_STEERS;
      if (sameOrigin.length >= maxCount) return false;
      const budgeted =
        origin === 'background_subagent'
          ? pending
          : pending.filter(
              (candidate) => (candidate.origin ?? 'user') !== 'background_subagent'
            );
      const pendingSize = budgeted.reduce(
        (total, candidate) => total + getSteeringContentSize(candidate.content),
        0
      );
      const pendingSchemaSize = budgeted.reduce(
        (total, candidate) => total + getOutputSchemaSize(candidate.outputSchema),
        0
      );
      const pendingMetadataSize = budgeted.reduce(
        (total, candidate) => total + getMetadataSize(candidate.metadata),
        0
      );
      const maxChars =
        origin === 'background_subagent'
          ? MAX_PENDING_BACKGROUND_COMPLETION_CHARS
          : MAX_PENDING_STEER_CHARS;
      return (
        pendingSize +
          pendingSchemaSize +
          pendingMetadataSize +
          getSteeringContentSize(content) +
          getOutputSchemaSize(options.outputSchema) +
          getMetadataSize(options.metadata) <=
        maxChars
      );
    });
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
      messageId: message.id,
      turnId: this.activeTurn?.id,
      queued: this.inbox.count(),
      delivery,
    };
  }

  private createTurn(): ActiveTurnHandle {
    const handle = { id: nanoid(12) };
    this.activeTurn = { id: handle.id, sealed: false };
    return handle;
  }
}
