import { describe, expect, it } from 'vitest';
import {
  isSessionTaskFailure,
  toTaskFailure,
} from '../../../../src/context/taskFailure.js';
import { TaskAdmissionQueueFullError } from '../../../../src/agent/runtime/TaskRunScheduler.js';

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

  it.each([
    'pending_count',
    'pending_bytes',
  ] as const)('preserves sanitized %s capacity ownership', (resource) => {
    const failure = toTaskFailure(new TaskAdmissionQueueFullError(resource, 64 * 1024));

    expect(failure).toEqual({
      code: 'capacity',
      message: 'Task admission capacity is full. Retry after running tasks complete.',
      retryable: true,
      resource,
    });
    expect(isSessionTaskFailure(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(String(64 * 1024));
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

  it('fails closed when inspecting a hostile error object', () => {
    const hostile = new Proxy(
      {},
      {
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
