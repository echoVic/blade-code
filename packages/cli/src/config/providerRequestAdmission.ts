export const DEFAULT_PROVIDER_REQUEST_CONCURRENCY = 4;
export const MIN_PROVIDER_REQUEST_CONCURRENCY = 1;
export const MAX_PROVIDER_REQUEST_CONCURRENCY = 16;

export const DEFAULT_PROVIDER_REQUEST_ADMISSION_MS = 180_000;
export const MIN_PROVIDER_REQUEST_ADMISSION_MS = 1_000;
export const MAX_PROVIDER_REQUEST_ADMISSION_MS = 600_000;

export function isValidProviderRequestConcurrency(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_PROVIDER_REQUEST_CONCURRENCY &&
    value <= MAX_PROVIDER_REQUEST_CONCURRENCY
  );
}

export function normalizeProviderRequestConcurrency(
  value: unknown,
  fallback = DEFAULT_PROVIDER_REQUEST_CONCURRENCY
): number {
  return isValidProviderRequestConcurrency(value) ? value : fallback;
}

export function isValidProviderRequestAdmissionMs(value: unknown): value is number {
  return (
    value === 0 ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_PROVIDER_REQUEST_ADMISSION_MS &&
      value <= MAX_PROVIDER_REQUEST_ADMISSION_MS)
  );
}

export function normalizeProviderRequestAdmissionMs(
  value: unknown,
  fallback = DEFAULT_PROVIDER_REQUEST_ADMISSION_MS
): number {
  return isValidProviderRequestAdmissionMs(value) ? value : fallback;
}
