export const MIN_CONCURRENT_TASKS = 1;
export const MAX_CONCURRENT_TASKS = 64;
export const MIN_QUEUED_TASKS = 1;
export const MAX_QUEUED_TASKS = 10_000;

export function isValidConcurrentTaskLimit(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_CONCURRENT_TASKS &&
    value <= MAX_CONCURRENT_TASKS
  );
}

export function isValidQueuedTaskLimit(value: number): boolean {
  return (
    Number.isInteger(value) && value >= MIN_QUEUED_TASKS && value <= MAX_QUEUED_TASKS
  );
}
