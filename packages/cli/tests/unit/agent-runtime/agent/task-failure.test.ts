import { describe, expect, it } from 'vitest';
import { SessionRuntimeCapacityError } from '../../../../src/agent/runtime/SessionRuntimeResidency.js';
import { TaskAdmissionQueueFullError } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import {
  isSessionTaskFailure,
  toTaskFailure,
} from '../../../../src/context/taskFailure.js';

describe('taskFailure', () => {
  it('classifies retryable provider failures without persisting paths or secrets', () => {
    const failure = toTaskFailure(
      new Error(
        'Timeout reading /Users/alice/private/project/config.json ' +
          'opaque-sensitive-value-123456789'
      )
    );

    expect(failure).toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    expect(failure.message).toBe('Provider request timed out.');
    expect(failure.message).not.toContain('/Users/alice');
    expect(failure.message).not.toContain('opaque-sensitive-value-123456789');
    expect(isSessionTaskFailure(failure)).toBe(true);
  });

  it.each([
    'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
    'PROVIDER_REQUEST_DEADLINE_EXCEEDED',
    'STREAM_IDLE_TIMEOUT',
  ] as const)('maps %s to canonical timeout without leaking details', (code) => {
    const failure = toTaskFailure(
      Object.assign(new Error('opaque secret and /private/path'), { code })
    );

    expect(failure).toEqual({
      code: 'timeout',
      message: 'Provider request timed out.',
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain('opaque secret');
    expect(JSON.stringify(failure)).not.toContain('/private/path');
  });

  it('finds a timeout code through a bounded lastError chain', () => {
    const failure = toTaskFailure({
      message: 'outer provider failure',
      lastError: Object.assign(new Error('inner provider failure'), {
        code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
      }),
    });

    expect(failure).toEqual({
      code: 'timeout',
      message: 'Provider request timed out.',
      retryable: true,
    });
  });

  it('inspects no more than eight errors in a lastError chain', () => {
    interface ChainError {
      code?: string;
      message: string;
      lastError?: unknown;
    }

    const atLimit: ChainError = { message: 'level 1' };
    let cursor = atLimit;
    for (let depth = 2; depth <= 8; depth++) {
      const next: ChainError = { message: `level ${depth}` };
      cursor.lastError = next;
      cursor = next;
    }
    cursor.lastError = Object.assign(new Error('level 9'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });

    expect(toTaskFailure(atLimit)).toEqual({
      code: 'runtime',
      message: 'Agent execution failed.',
      retryable: true,
    });
    cursor.code = 'STREAM_IDLE_TIMEOUT';
    expect(toTaskFailure(atLimit)).toEqual({
      code: 'timeout',
      message: 'Provider request timed out.',
      retryable: true,
    });
  });

  it('stops a cyclic lastError chain without throwing', () => {
    const cyclic: { message: string; lastError?: unknown } = {
      message: 'outer provider failure',
    };
    cyclic.lastError = cyclic;

    expect(toTaskFailure(cyclic)).toEqual({
      code: 'runtime',
      message: 'Agent execution failed.',
      retryable: true,
    });
  });

  it.each([
    ['401 invalid API key', 'authentication', false],
    ['403 permission denied', 'permission', false],
    ['429 rate limit exceeded', 'rate_limit', true],
    ['ECONNREFUSED provider connection', 'network', true],
    ['Model unavailable', 'model_unavailable', true],
    ['Maximum context length exceeded', 'context_limit', false],
    ['Model does not support images', 'unsupported_input', false],
    ['Task admission queue capacity is full', 'capacity', true],
  ] as const)('classifies %s as %s', (message, code, retryable) => {
    expect(toTaskFailure(message)).toMatchObject({ code, retryable });
  });

  it.each(['pending_count', 'pending_bytes'] as const)(
    'preserves sanitized %s capacity ownership',
    (resource) => {
      const failure = toTaskFailure(
        new TaskAdmissionQueueFullError(resource, 64 * 1024)
      );

      expect(failure).toEqual({
        code: 'capacity',
        message: 'Task admission capacity is full. Retry after running tasks complete.',
        retryable: true,
        resource,
      });
      expect(isSessionTaskFailure(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(String(64 * 1024));
    }
  );

  it('preserves sanitized resident Runtime capacity ownership', () => {
    const failure = toTaskFailure(new SessionRuntimeCapacityError(32));

    expect(failure).toEqual({
      code: 'capacity',
      message: 'Task admission capacity is full. Retry after running tasks complete.',
      retryable: true,
      resource: 'resident_runtimes',
    });
    expect(isSessionTaskFailure(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('32');
  });

  it('classifies an unavailable managed worktree without exposing its path', () => {
    const failure = toTaskFailure(
      Object.assign(new Error('/private/task/worktree no longer exists'), {
        name: 'WorktreeUnavailableError',
        reason: 'missing',
      })
    );

    expect(failure).toEqual({
      code: 'workspace_unavailable',
      message: 'The Session workspace is no longer available.',
      retryable: false,
    });
    expect(isSessionTaskFailure(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('/private/task/worktree');
  });

  it('uses bounded canonical messages and rejects malformed stored failures', () => {
    const failure = toTaskFailure('x'.repeat(1_000));
    expect(failure.message).toBe('Agent execution failed.');
    expect(isSessionTaskFailure(failure)).toBe(true);
    expect(
      isSessionTaskFailure({
        code: 'runtime',
        message: '',
        retryable: true,
      })
    ).toBe(false);
    expect(
      isSessionTaskFailure({
        code: 'runtime',
        message: 'Agent execution failed.',
        retryable: true,
        resource: 'pending_bytes',
      })
    ).toBe(false);
  });

  it('is idempotent when projecting a canonical legacy reason', () => {
    const once = toTaskFailure(
      'Timeout at /Users/alice/private/config.json api_key=sk-secret-value'
    );
    const twice = toTaskFailure(once.message);
    expect(twice.message).toBe(once.message);
  });

  it('idempotently preserves only allowed fields from a canonical failure', () => {
    const canonical = {
      code: 'capacity' as const,
      message: 'Task admission capacity is full. Retry after running tasks complete.',
      retryable: true,
      resource: 'pending_bytes' as const,
      detail: 'opaque secret and /private/path',
      lastError: Object.assign(new Error('inner provider failure'), {
        code: 'STREAM_IDLE_TIMEOUT',
      }),
    };

    const once = toTaskFailure(canonical);
    expect(once).toEqual({
      code: 'capacity',
      message: 'Task admission capacity is full. Retry after running tasks complete.',
      retryable: true,
      resource: 'pending_bytes',
    });
    expect(toTaskFailure(once)).toEqual(once);
  });

  it('fails closed when inspecting a hostile error object', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('do not expose this value');
        },
        getPrototypeOf() {
          throw new Error('do not expose this value');
        },
        has() {
          throw new Error('do not expose this value');
        },
      }
    );
    expect(toTaskFailure(hostile)).toEqual({
      code: 'runtime',
      message: 'Agent execution failed.',
      retryable: true,
    });
  });
});
