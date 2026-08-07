import { describe, expect, it } from 'vitest';
import {
  anchoredScrollTop,
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
});
