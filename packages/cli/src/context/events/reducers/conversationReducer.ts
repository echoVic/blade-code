import type { EphemeralDelta } from '../EphemeralDelta.js';
import type { SessionEvent } from '../../types.js';
import type { SessionMessage } from '../../../store/types.js';

/**
 * Conversation read-model — the shared CQRS projection.
 *
 * A pure reducer over the unified session stream that all ends (CLI store, and
 * anything else needing a rendered conversation view) fold to derive the UI
 * message list. Committed events ({@link SessionEvent}) are the durable truth;
 * ephemeral deltas ({@link EphemeralDelta}) overlay in-flight streaming text
 * that has not yet been superseded by a committed `part_updated`.
 *
 * The projection is deliberately UI-shaped (flat {@link SessionMessage}[]),
 * mirroring the semantics of SessionService.convertJSONLToMessages but produced
 * incrementally so live streaming can reuse the exact same fold.
 */
export interface ConversationState {
  /** Rendered messages in stream order. */
  messages: SessionMessage[];
  /** Live streaming overlays keyed by partId (content channel), not yet committed. */
  streamingText: Map<string, { messageId: string; text: string }>;
}

export function createConversationState(): ConversationState {
  return { messages: [], streamingText: new Map() };
}

function upsertMessage(
  state: ConversationState,
  id: string,
  role: SessionMessage['role'],
  timestamp: number
): SessionMessage {
  const existing = state.messages.find((m) => m.id === id);
  if (existing) return existing;
  const message: SessionMessage = { id, role, content: '', timestamp };
  state.messages.push(message);
  return message;
}

/**
 * Fold one committed event into the conversation state. Pure w.r.t. inputs:
 * mutates and returns the passed-in state for fold efficiency, never touches
 * external state.
 */
export function applyCommittedEvent(
  state: ConversationState,
  event: SessionEvent
): ConversationState {
  const timestamp = Date.parse(event.timestamp) || Date.now();
  switch (event.type) {
    case 'message_created': {
      upsertMessage(state, event.data.messageId, event.data.role, timestamp);
      return state;
    }
    case 'part_created':
    case 'part_updated': {
      const { messageId, partType, payload, partId } = event.data;
      const message =
        state.messages.find((m) => m.id === messageId) ??
        upsertMessage(state, messageId, 'assistant', timestamp);
      if (partType === 'text') {
        const text = (payload as { text?: string }).text ?? '';
        // A committed text part is the final truth for its part — drop any
        // live streaming overlay anchored to it and set the message content.
        state.streamingText.delete(partId);
        message.content = text;
      } else if (partType === 'image') {
        message.content = message.content
          ? `${message.content}\n[Image]`
          : '[Image]';
      }
      return state;
    }
    default:
      return state;
  }
}

/**
 * Overlay an ephemeral streaming delta. Accumulates in-flight text for the
 * anchored part; the message content reflects the running concatenation until a
 * committed `part_updated` supersedes it via {@link applyCommittedEvent}.
 */
export function applyDelta(
  state: ConversationState,
  delta: EphemeralDelta
): ConversationState {
  if (delta.channel !== 'content') return state;
  const message =
    state.messages.find((m) => m.id === delta.messageId) ??
    upsertMessage(state, delta.messageId, 'assistant', Date.now());
  const prev = state.streamingText.get(delta.partId)?.text ?? '';
  const text = prev + delta.delta;
  state.streamingText.set(delta.partId, { messageId: delta.messageId, text });
  message.content = text;
  return state;
}

/** Fold an ordered committed event stream into a fresh conversation projection. */
export function projectConversation(events: readonly SessionEvent[]): ConversationState {
  const state = createConversationState();
  for (const event of events) applyCommittedEvent(state, event);
  return state;
}
