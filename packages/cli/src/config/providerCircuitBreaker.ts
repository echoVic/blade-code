export const DEFAULT_PROVIDER_CIRCUIT_OPEN_MS = 10_000;
export const MIN_PROVIDER_CIRCUIT_OPEN_MS = 1_000;
export const MAX_PROVIDER_CIRCUIT_OPEN_MS = 300_000;

export function isValidProviderCircuitOpenMs(value: unknown): value is number {
  return (
    value === 0 ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_PROVIDER_CIRCUIT_OPEN_MS &&
      value <= MAX_PROVIDER_CIRCUIT_OPEN_MS)
  );
}

export function normalizeProviderCircuitOpenMs(
  value: unknown,
  fallback = DEFAULT_PROVIDER_CIRCUIT_OPEN_MS
): number {
  return isValidProviderCircuitOpenMs(value) ? value : fallback;
}
