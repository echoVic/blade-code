import { describe, expect, it } from 'vitest';
import {
  computeExpiry,
  computeNextRun,
  nextCronRun,
  parseCron,
  parseIntervalMs,
  validateTrigger,
} from '../../../../src/agent/runtime/scheduleTiming.js';

describe('scheduleTiming', () => {
  it('parses ranges, steps, lists, and Sunday aliases', () => {
    const parsed = parseCron('*/15 9-17 * * 1-5');
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45]);
    expect(parsed.hours.has(9)).toBe(true);
    expect(parsed.hours.has(17)).toBe(true);
    expect(parsed.daysOfWeek.has(1)).toBe(true);
    expect(parsed.daysOfWeek.has(6)).toBe(false);

    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual(new Set([0]));
    expect(() => parseCron('0 9 * *')).toThrow('must have 5 fields');
    expect(() => parseCron('61 9 * * *')).toThrow('Invalid cron range');
  });

  it('computes the next cron instant in an explicit timezone', () => {
    const from = new Date('2026-08-10T22:00:00.000Z');
    expect(nextCronRun('0 9 * * *', from, 'Asia/Shanghai')?.toISOString()).toBe(
      '2026-08-11T01:00:00.000Z'
    );
    expect(nextCronRun('0 9 * * *', from, 'America/New_York')?.toISOString()).toBe(
      '2026-08-11T13:00:00.000Z'
    );
  });

  it('normalizes friendly intervals and computes recurring/one-shot runs', () => {
    expect(parseIntervalMs('30m')).toBe(1_800_000);
    expect(parseIntervalMs('2h')).toBe(7_200_000);
    expect(parseIntervalMs('90s')).toBe(90_000);
    expect(parseIntervalMs('bad')).toBeNull();

    const from = new Date('2026-08-11T00:00:00.000Z');
    expect(
      computeNextRun({ kind: 'interval', intervalMs: 60_000 }, from)?.toISOString()
    ).toBe('2026-08-11T00:01:00.000Z');
    expect(
      computeNextRun(
        { kind: 'once', runAt: '2026-08-11T00:05:00.000Z' },
        from
      )?.toISOString()
    ).toBe('2026-08-11T00:05:00.000Z');
    expect(
      computeNextRun({ kind: 'once', runAt: '2026-08-10T23:59:00.000Z' }, from)
    ).toBeNull();
  });

  it('validates trigger-specific fields and expires recurring schedules', () => {
    expect(
      validateTrigger({ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' })
    ).toBeNull();
    expect(
      validateTrigger({ kind: 'cron', cron: '0 9 * * *', timezone: 'Bad/Zone' })
    ).toContain('Invalid time zone');
    expect(validateTrigger({ kind: 'interval', intervalMs: 59_999 })).toContain(
      'intervalMs'
    );
    expect(validateTrigger({ kind: 'once' })).toContain('runAt');

    const from = new Date('2026-08-11T00:00:00.000Z');
    expect(
      computeExpiry({ kind: 'interval', intervalMs: 60_000 }, from)?.toISOString()
    ).toBe('2026-08-18T00:00:00.000Z');
    expect(
      computeExpiry({ kind: 'once', runAt: '2026-08-11T00:05:00.000Z' }, from)
    ).toBeNull();
  });
});
