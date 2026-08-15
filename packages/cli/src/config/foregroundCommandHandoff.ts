export const DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS = 15_000;
export const MIN_FOREGROUND_COMMAND_HANDOFF_MS = 1_000;
export const MAX_FOREGROUND_COMMAND_HANDOFF_MS = 300_000;

export function isValidForegroundCommandHandoffMs(value: unknown): value is number {
  return (
    value === 0 ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_FOREGROUND_COMMAND_HANDOFF_MS &&
      value <= MAX_FOREGROUND_COMMAND_HANDOFF_MS)
  );
}

export function normalizeForegroundCommandHandoffMs(
  value: unknown,
  fallback = DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS
): number {
  return isValidForegroundCommandHandoffMs(value) ? value : fallback;
}
