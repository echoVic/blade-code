import { describe, expect, it } from 'vitest';
import { ConversationRecapSchedule } from '../../../src/services/ConversationRecapSchedule.js';

describe('ConversationRecapSchedule', () => {
  it('requires both elapsed time and progress, and spends the interval before generation', () => {
    const schedule = new ConversationRecapSchedule(0);
    expect(schedule.claim(4, 120000)).toBe(false);
    expect(schedule.claim(5, 119999)).toBe(false);
    expect(schedule.claim(5, 120000)).toBe(true);
    expect(schedule.claim(5, 240000)).toBe(false);
    expect(schedule.claim(10, 240000)).toBe(true);
    expect(schedule.claim(11, 240001)).toBe(false);
  });

  it('allows compaction to replace the round threshold but never bypasses the cooldown', () => {
    const schedule = new ConversationRecapSchedule(0);
    expect(schedule.claim(1, 60000, true)).toBe(false);
    expect(schedule.claim(2, 120000, true)).toBe(true);
    expect(schedule.claim(3, 120001, true)).toBe(false);
  });
});
