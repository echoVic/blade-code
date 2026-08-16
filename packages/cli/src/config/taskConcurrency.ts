export const MIN_CONCURRENT_TASKS = 1;
export const MAX_CONCURRENT_TASKS = 64;
export const MIN_QUEUED_TASKS = 1;
export const MAX_QUEUED_TASKS = 10_000;
export const DEFAULT_MAX_QUEUED_TASK_BYTES = 64 * 1024 * 1024;
export const MIN_MAX_QUEUED_TASK_BYTES = 64 * 1024;
export const MAX_MAX_QUEUED_TASK_BYTES = 128 * 1024 * 1024;

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

export function isValidQueuedTaskByteLimit(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_MAX_QUEUED_TASK_BYTES &&
    value <= MAX_MAX_QUEUED_TASK_BYTES
  );
}
