export const MIN_RESIDENT_SESSION_RUNTIMES = 1;
export const DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES = 32;
export const MAX_RESIDENT_SESSION_RUNTIMES = 256;

export const MIN_SESSION_RUNTIME_IDLE_MS = 30_000;
export const DEFAULT_SESSION_RUNTIME_IDLE_MS = 5 * 60_000;
export const MAX_SESSION_RUNTIME_IDLE_MS = 60 * 60_000;

export const SESSION_RUNTIME_SWEEP_MS = 30_000;

export function isValidResidentSessionRuntimeLimit(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_RESIDENT_SESSION_RUNTIMES &&
    value <= MAX_RESIDENT_SESSION_RUNTIMES
  );
}

export function isValidSessionRuntimeIdleMs(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_SESSION_RUNTIME_IDLE_MS &&
    value <= MAX_SESSION_RUNTIME_IDLE_MS
  );
}
