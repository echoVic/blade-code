/**
 * Schedule timing — trigger parsing and next-run computation.
 *
 * Supports three trigger kinds (see `ScheduleTrigger` in api/schemas):
 *   - `cron`     : standard 5-field expression (min hour dom mon dow)
 *   - `interval` : fixed millisecond cadence (normalized from Ns/Nm/Nh/Nd)
 *   - `once`     : a single future ISO timestamp
 *
 * The cron evaluator is intentionally dependency-free and covers the common
 * field syntax: star, `a`, `a-b`, `a-b/step`, `star/step`, and comma lists of
 * the former. Day-of-month / day-of-week follow the standard cron OR semantics
 * when both are restricted. Times are evaluated in the host local timezone
 * (an explicit IANA timezone is accepted for display but the tick loop runs
 * in local time, matching Claude/Codex behavior of "local wall-clock").
 */

import type { ScheduleTrigger } from '../../api/schemas.js';

/** Recurring schedules auto-expire after this many days, matching industry default. */
export const DEFAULT_SCHEDULE_MAX_AGE_DAYS = 7;

const CRON_FIELD_RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 or 7 = Sunday)
];

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether dom / dow were explicitly restricted (drives OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse one cron field into the set of allowed integer values. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step in "${field}"`);
    }
    let start = min;
    let end = max;
    if (rangePart !== '*' && rangePart !== '') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        start = Number.parseInt(a, 10);
        end = Number.parseInt(b, 10);
      } else {
        start = Number.parseInt(rangePart, 10);
        end = start;
      }
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Invalid cron range "${rangePart}" in field "${field}"`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

/** Parse a standard 5-field cron expression. Throws on malformed input. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (min hour dom mon dow), got ${fields.length}`
    );
  }
  const [minute, hour, dom, month, dow] = fields;
  const parsedDow = parseCronField(
    dow,
    CRON_FIELD_RANGES[4].min,
    CRON_FIELD_RANGES[4].max
  );
  const normalizedDow = new Set(
    [...parsedDow].map((value) => (value === 7 ? 0 : value))
  );
  return {
    minutes: parseCronField(minute, CRON_FIELD_RANGES[0].min, CRON_FIELD_RANGES[0].max),
    hours: parseCronField(hour, CRON_FIELD_RANGES[1].min, CRON_FIELD_RANGES[1].max),
    daysOfMonth: parseCronField(
      dom,
      CRON_FIELD_RANGES[2].min,
      CRON_FIELD_RANGES[2].max
    ),
    months: parseCronField(month, CRON_FIELD_RANGES[3].min, CRON_FIELD_RANGES[3].max),
    daysOfWeek: normalizedDow,
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function cronDateParts(date: Date, timezone?: string): CronDateParts {
  if (!timezone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    };
  }
  let formatter = timezoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    timezoneFormatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: WEEKDAY_INDEX[values.weekday] ?? -1,
  };
}

/** Does a given instant match the parsed cron spec in the selected timezone? */
function cronMatches(parsed: ParsedCron, date: Date, timezone?: string): boolean {
  const parts = cronDateParts(date, timezone);
  if (!parsed.minutes.has(parts.minute)) return false;
  if (!parsed.hours.has(parts.hour)) return false;
  if (!parsed.months.has(parts.month)) return false;

  const domMatch = parsed.daysOfMonth.has(parts.dayOfMonth);
  const dowMatch = parsed.daysOfWeek.has(parts.dayOfWeek);

  // Standard cron: when both DOM and DOW are restricted, match either;
  // when only one is restricted, that one must match.
  if (parsed.domRestricted && parsed.dowRestricted) {
    return domMatch || dowMatch;
  }
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

/**
 * Compute the next fire time strictly after `from` for a cron expression.
 * Scans minute-by-minute up to a 4-year horizon; returns null if unreachable
 * (e.g. Feb 30). `from` is treated in local time.
 */
export function nextCronRun(
  expression: string,
  from: Date,
  timezone?: string
): Date | null {
  const parsed = parseCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // strictly after `from`

  const horizon = new Date(from.getTime());
  horizon.setFullYear(horizon.getFullYear() + 4);

  while (cursor.getTime() <= horizon.getTime()) {
    if (cronMatches(parsed, cursor, timezone)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

const INTERVAL_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a human interval token (e.g. "30m", "2h", "1d", "90s") to milliseconds.
 * Accepts a bare number of minutes as a fallback. Returns null when invalid.
 */
export function parseIntervalMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*([smhd]?)$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const unit = match[2] || 'm';
  return amount * INTERVAL_UNIT_MS[unit];
}

/** Format a millisecond interval back to a compact human token (e.g. "2h"). */
export function formatIntervalMs(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = INTERVAL_UNIT_MS[unit];
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Compute the next run time for any trigger, strictly after `from`.
 * - cron: next matching minute.
 * - interval: from + intervalMs (or, if lastRunAt provided, aligned to cadence).
 * - once: the runAt timestamp if still in the future, else null.
 * Returns null when the schedule has no future run.
 */
export function computeNextRun(
  trigger: ScheduleTrigger,
  from: Date,
  lastRunAt?: Date
): Date | null {
  switch (trigger.kind) {
    case 'cron': {
      if (!trigger.cron) return null;
      try {
        return nextCronRun(trigger.cron, from, trigger.timezone);
      } catch {
        return null;
      }
    }
    case 'interval': {
      if (!trigger.intervalMs || trigger.intervalMs <= 0) return null;
      const base = lastRunAt ?? from;
      const next = new Date(base.getTime() + trigger.intervalMs);
      // If the computed next run is already in the past (missed while offline),
      // fire once on the next tick rather than replaying every missed slot.
      return next.getTime() <= from.getTime() ? new Date(from.getTime() + 1000) : next;
    }
    case 'once': {
      if (!trigger.runAt) return null;
      const runAt = new Date(trigger.runAt);
      if (Number.isNaN(runAt.getTime())) return null;
      return runAt.getTime() > from.getTime() ? runAt : null;
    }
    default:
      return null;
  }
}

/** Validate a trigger definition, returning an error message or null. */
export function validateTrigger(trigger: ScheduleTrigger): string | null {
  switch (trigger.kind) {
    case 'cron':
      if (!trigger.cron) return 'cron trigger requires a cron expression';
      try {
        parseCron(trigger.cron);
        if (trigger.timezone) {
          new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format();
        }
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'invalid cron expression';
      }
    case 'interval':
      if (!trigger.intervalMs || trigger.intervalMs < 60_000) {
        return 'interval trigger requires intervalMs >= 60000 (1 minute)';
      }
      return null;
    case 'once': {
      if (!trigger.runAt) return 'once trigger requires runAt timestamp';
      const runAt = new Date(trigger.runAt);
      if (Number.isNaN(runAt.getTime()))
        return 'once trigger runAt is not a valid date';
      return null;
    }
    default:
      return 'unknown trigger kind';
  }
}

/**
 * Compute the auto-expiry timestamp for a recurring schedule (cron/interval).
 * One-shot schedules never expire (they self-disable after firing).
 */
export function computeExpiry(
  trigger: ScheduleTrigger,
  from: Date,
  maxAgeDays = DEFAULT_SCHEDULE_MAX_AGE_DAYS
): Date | null {
  if (trigger.kind === 'once') return null;
  const expiry = new Date(from.getTime());
  expiry.setDate(expiry.getDate() + maxAgeDays);
  return expiry;
}

/** Render a trigger as a short human-readable cadence label. */
export function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case 'cron':
      return `cron: ${trigger.cron ?? '?'}`;
    case 'interval':
      return `every ${trigger.intervalMs ? formatIntervalMs(trigger.intervalMs) : '?'}`;
    case 'once':
      return `once at ${trigger.runAt ?? '?'}`;
    default:
      return 'unknown';
  }
}
