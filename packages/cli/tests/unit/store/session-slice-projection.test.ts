import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createSessionSlice } from '../../../src/store/slices/sessionSlice.js';
import type { BladeStore } from '../../../src/store/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import type { EphemeralDelta } from '../../../src/context/events/EphemeralDelta.js';

const ts = '2024-01-01T00:00:00.000Z';

function evt(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
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

/** A minimal store exposing only the session slice for projection testing. */
function makeStore() {
  return createStore<Pick<BladeStore, 'session'>>()((set, get, api) => ({
    session: createSessionSlice(
      set as never,
      get as never,
      api as never
    ) as BladeStore['session'],
  }));
}

describe('sessionSlice event-sourcing projection', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
    store.getState().session.actions.resetConversationProjection();
  });

  it('derives messages from committed events (store as read-model)', () => {
    const { actions } = store.getState().session;
    actions.applyCommittedEvent(evt(1, 'message_created', { messageId: 'm1', role: 'user', createdAt: ts }));
    actions.applyCommittedEvent(
      evt(2, 'part_created', {
        partId: 'p1',
        messageId: 'm1',
        partType: 'text',
        payload: { text: 'hello world' },
        createdAt: ts,
      })
    );

    const messages = store.getState().session.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', role: 'user', content: 'hello world' });
  });

  it('overlays streaming deltas and lets a committed part_updated supersede them', () => {
    const { actions } = store.getState().session;
    actions.applyCommittedEvent(
      evt(1, 'message_created', { messageId: 'm1', role: 'assistant', createdAt: ts })
    );

    const delta = (text: string, i: number): EphemeralDelta => ({
      sessionId: 's',
      projectPath: '/w',
      anchorSeq: 1,
      partId: 'p1',
      messageId: 'm1',
      partType: 'text',
      channel: 'content',
      deltaIndex: i,
      delta: text,
    });
    actions.applyStreamingDelta(delta('Hel', 0));
    actions.applyStreamingDelta(delta('lo', 1));
    expect(store.getState().session.messages[0].content).toBe('Hello');

    actions.applyCommittedEvent(
      evt(2, 'part_updated', {
        partId: 'p1',
        messageId: 'm1',
        partType: 'text',
        payload: { text: 'Hello, world!' },
        createdAt: ts,
      })
    );
    expect(store.getState().session.messages[0].content).toBe('Hello, world!');
  });
});
