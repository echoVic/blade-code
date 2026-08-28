import { describe, expect, it } from 'vitest';
import {
  anchoredScrollTop,
  collectUnreadMessageIds,
  nextVisibleMessageCount,
} from '@/components/chat/chatListWindow';

describe('chat list window', () => {
  it('preserves the visible content anchor when earlier history is prepended', () => {
    expect(anchoredScrollTop(420, 2_000, 3_200)).toBe(1_620);
  });

  it('guards against negative scroll positions when content shrinks', () => {
    expect(anchoredScrollTop(100, 1_000, 400)).toBe(0);
  });

  it('loads history in bounded batches without exceeding the total', () => {
    expect(nextVisibleMessageCount(120, 500, 80)).toBe(200);
    expect(nextVisibleMessageCount(480, 500, 80)).toBe(500);
  });

  it('counts unique new or updated messages while preserving prior unread ids', () => {
    const previous = [
      { id: 'a', content: 'stable' },
      { id: 'b', content: 'streaming' },
    ];
    const updatedB = { id: 'b', content: 'streaming update' };

    const first = collectUnreadMessageIds(
      previous,
      [previous[0]!, updatedB, { id: 'c', content: 'tool result' }],
      new Set()
    );
    expect([...first]).toEqual(['b', 'c']);

    const second = collectUnreadMessageIds(
      [previous[0]!, updatedB],
      [previous[0]!, { id: 'b', content: 'another delta' }],
      first
    );
    expect([...second]).toEqual(['b', 'c']);
  });

  it('does not count semantically identical snapshot objects as unread', () => {
    const revision = (message: { content: string }) => message.content;
    expect(
      collectUnreadMessageIds(
        [{ id: 'a', content: 'same' }],
        [{ id: 'a', content: 'same' }],
        new Set(),
        revision
      )
    ).toEqual(new Set());
  });
});
