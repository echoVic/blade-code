import { describe, expect, it } from 'vitest';
import type { EphemeralDelta } from '../../../../src/context/events/EphemeralDelta.js';
import {
  applyCommittedEvent,
  applyDelta,
  createConversationState,
  projectConversation,
} from '../../../../src/context/events/reducers/conversationReducer.js';
import type { SessionEvent } from '../../../../src/context/types.js';

const ts = '2024-01-01T00:00:00.000Z';

function base(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return {
    seq,
    id: `e${seq}`,
    sessionId: 's',
    projectPath: '/w',
    timestamp: ts,
    type,
    cwd: '/w',
    version: 'test',
    data,
  } as SessionEvent;
}

function messageCreated(seq: number, messageId: string, role: string): SessionEvent {
  return base(seq, 'message_created', { messageId, role, createdAt: ts });
}

function textPart(
  seq: number,
  messageId: string,
  partId: string,
  text: string,
  type: 'part_created' | 'part_updated' = 'part_created'
): SessionEvent {
  return base(seq, type, {
    partId,
    messageId,
    partType: 'text',
    payload: { text },
    createdAt: ts,
  });
}

function delta(
  partId: string,
  messageId: string,
  text: string,
  index: number
): EphemeralDelta {
  return {
    sessionId: 's',
    projectPath: '/w',
    anchorSeq: 1,
    partId,
    messageId,
    partType: 'text',
    channel: 'content',
    deltaIndex: index,
    delta: text,
  };
}

describe('conversationReducer', () => {
  it('projects a committed message + text part into a rendered message', () => {
    const events = [messageCreated(1, 'm1', 'user'), textPart(2, 'm1', 'p1', 'hello')];
    const state = projectConversation(events);
    expect(state.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hello', timestamp: Date.parse(ts) },
    ]);
  });

  it('is deterministic: same events fold to the same projection', () => {
    const events = [
      messageCreated(1, 'm1', 'user'),
      textPart(2, 'm1', 'p1', 'hi'),
      messageCreated(3, 'm2', 'assistant'),
      textPart(4, 'm2', 'p2', 'yo'),
    ];
    expect(projectConversation(events)).toEqual(projectConversation(events));
  });

  it('overlays streaming deltas then lets a committed part_updated supersede them', () => {
    const state = createConversationState();
    applyCommittedEvent(state, messageCreated(1, 'm1', 'assistant'));
    applyDelta(state, delta('p1', 'm1', 'Hel', 0));
    applyDelta(state, delta('p1', 'm1', 'lo', 1));
    expect(state.messages[0].content).toBe('Hello');
    expect(state.streamingText.has('p1')).toBe(true);

    // The committed final text supersedes the live overlay idempotently.
    applyCommittedEvent(state, textPart(2, 'm1', 'p1', 'Hello world', 'part_updated'));
    expect(state.messages[0].content).toBe('Hello world');
    expect(state.streamingText.has('p1')).toBe(false);
  });

  it('replaying committed history without deltas reconstructs the final text', () => {
    // Simulates reconnect: no deltas replayed, only committed truth.
    const events = [
      messageCreated(1, 'm1', 'assistant'),
      textPart(2, 'm1', 'p1', 'final answer', 'part_updated'),
    ];
    expect(projectConversation(events).messages[0].content).toBe('final answer');
  });

  it('ignores content-less channels and unknown event types', () => {
    const state = createConversationState();
    applyCommittedEvent(state, messageCreated(1, 'm1', 'assistant'));
    applyDelta(state, { ...delta('p1', 'm1', 'x', 0), channel: 'thinking' });
    expect(state.messages[0].content).toBe('');
  });
});
