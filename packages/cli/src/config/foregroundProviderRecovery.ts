export const DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS = 600_000;
export const MIN_FOREGROUND_PROVIDER_RECOVERY_MS = 30_000;
export const MAX_FOREGROUND_PROVIDER_RECOVERY_MS = 3_600_000;

export const DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES = 12;
export const PROVIDER_RECOVERY_HEARTBEAT_MS = 15_000;
export const MAX_FOREGROUND_PROVIDER_RETRY_DELAY_MS = 60_000;

export function isValidForegroundProviderRecoveryMs(value: unknown): value is number {
  return (
    value === 0 ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_FOREGROUND_PROVIDER_RECOVERY_MS &&
      value <= MAX_FOREGROUND_PROVIDER_RECOVERY_MS)
  );
}

export function normalizeForegroundProviderRecoveryMs(
  value: unknown,
  fallback = DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS
): number {
  return isValidForegroundProviderRecoveryMs(value) ? value : fallback;
}
