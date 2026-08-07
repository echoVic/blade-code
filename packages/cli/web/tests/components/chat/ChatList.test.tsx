// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatList } from '../../../src/components/chat/ChatList';
import { setLocale } from '../../../src/i18n';

describe('ChatList loading history', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('replaces stale messages with an accessible conversation loading state', async () => {
    await act(async () => {
      root.render(
        <ChatList
          isLoading
          messages={[
            {
              id: 'stale-message',
              role: 'user',
              content: 'Content from the previous conversation',
              timestamp: Date.now(),
            },
          ]}
        />
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.textContent).toContain('Restoring conversation');
    expect(status?.textContent).toContain('Larger conversations may take a moment');
    expect(container.textContent).not.toContain(
      'Content from the previous conversation'
    );
  });
});
