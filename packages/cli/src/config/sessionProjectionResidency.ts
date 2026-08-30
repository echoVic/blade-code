export const MIN_RESIDENT_SESSION_PROJECTIONS = 1;
export const DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS = 256;
export const MAX_RESIDENT_SESSION_PROJECTIONS = 4096;

export const MIN_SESSION_PROJECTION_IDLE_MS = 30_000;
export const DEFAULT_SESSION_PROJECTION_IDLE_MS = 30 * 60_000;
export const MAX_SESSION_PROJECTION_IDLE_MS = 24 * 60 * 60_000;

export const SESSION_PROJECTION_SWEEP_MS = 30_000;
export const SESSION_PROJECTION_DRAIN_MS = 30_000;
export const MAX_SESSION_PROJECTION_WAKE_ENTRIES = 256;

export function isValidResidentSessionProjectionLimit(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_RESIDENT_SESSION_PROJECTIONS &&
    value <= MAX_RESIDENT_SESSION_PROJECTIONS
  );
}

export function isValidSessionProjectionIdleMs(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_SESSION_PROJECTION_IDLE_MS &&
    value <= MAX_SESSION_PROJECTION_IDLE_MS
  );
}
