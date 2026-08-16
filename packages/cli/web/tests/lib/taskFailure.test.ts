import { describe, expect, it } from 'vitest';
import {
  taskFailureCode,
  taskFailureIsRetryable,
  taskFailureMessageKey,
} from '@/lib/taskFailure';

describe('task failure projection', () => {
  it('projects task admission capacity as a retryable localized failure', () => {
    expect(taskFailureCode('capacity')).toBe('capacity');
    expect(taskFailureMessageKey('capacity')).toBe('task.failure.capacity');
    expect(taskFailureIsRetryable('capacity')).toBe(true);
  });

  it('rejects unknown capacity-like codes', () => {
    expect(taskFailureCode('pending_bytes')).toBeUndefined();
    expect(taskFailureCode('queue_full')).toBeUndefined();
  });
});
