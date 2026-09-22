import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { useSessionStore } from '@/store/session';
import { createEventDispatcher } from '@/store/session/handlers/eventHandlers';
import { aggregateMessages } from '@/store/session/utils/aggregateMessages';

describe('inline conversation recap', () => {
  const initial = useSessionStore.getState();
  afterEach(() => useSessionStore.setState(initial, true));

  it('renders a muted italic recap with no chat avatar or card', () => {
    const [message] = aggregateMessages([
      {
        id: 'recap-1',
        role: 'assistant',
        content: 'Goal: ship. Review pending.',
        timestamp: 1,
        metadata: { conversationRecap: true },
      },
    ]);
    const html = renderToStaticMarkup(<ChatMessage message={message!} />);
    expect(html).toContain('data-conversation-recap');
    expect(html).toContain('italic');
    expect(html).toContain('recap:');
    expect(html).toContain('Goal: ship. Review pending.');
    expect(html).not.toContain('button');
  });

  it('deduplicates live/replayed recaps without stealing the active assistant stream', () => {
    useSessionStore.setState({
      currentSessionId: 's',
      currentSessionRef: { sessionId: 's', projectPath: '/a' },
      isTemporarySession: false,
      messages: [],
      currentAssistantMessageId: 'main',
      isStreaming: true,
    });
    const dispatch = createEventDispatcher(
      useSessionStore.getState,
      useSessionStore.setState
    );
    const event = {
      type: 'conversation.recap',
      seq: 2,
      properties: {
        sessionId: 's',
        projectPath: '/a',
        messageId: 'r',
        text: 'Current progress.',
      },
    };
    dispatch(event);
    dispatch(event);
    dispatch({
      ...event,
      properties: { ...event.properties, projectPath: '/b', text: 'Wrong project' },
    });
    const state = useSessionStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'r',
      content: 'Current progress.',
      metadata: { conversationRecap: true },
    });
    expect(state.currentAssistantMessageId).toBe('main');
    expect(state.isStreaming).toBe(true);
  });
});
