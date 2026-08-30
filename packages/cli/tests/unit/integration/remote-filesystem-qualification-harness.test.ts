import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpCleanupError,
  buildCanonicalRemoteFilesystemQualificationEvidence,
  digestCanonicalRemoteFilesystemQualificationEvidence,
  isBenignPairedAcpWriterCloseError,
  runRemoteFilesystemQualificationCleanup,
  withRemainingDeadline,
} from '../../support/acp/remoteFilesystemQualification.js';

describe('remote filesystem qualification harness helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears its deadline timer after a successful operation resolves', async () => {
    const result = await withRemainingDeadline(async () => 'ok', {
      deadlineAt: 2_000,
      timeoutMessage: 'operation timed out',
    });

    expect(result).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline timer after the operation rejects', async () => {
    const failure = new Error('operation failed');

    await expect(
      withRemainingDeadline(
        async () => {
          throw failure;
        },
        {
          deadlineAt: 2_000,
          timeoutMessage: 'operation timed out',
        }
      )
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline timer after timing out', async () => {
    const pending = withRemainingDeadline(() => new Promise<string>(() => undefined), {
      deadlineAt: 1_500,
      timeoutMessage: 'operation timed out',
    });
    const handled = pending.catch((error) => error);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(handled).resolves.toMatchObject({
      message: 'operation timed out',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a body failure as the primary error when cleanup succeeds', async () => {
    const bodyFailure = new Error('body failed');
    const cleanup = vi.fn(async () => undefined);

    await expect(
      runRemoteFilesystemQualificationCleanup({
        bodyError: bodyFailure,
        deadlineAt: 2_000,
        operations: [
          {
            phase: 'client_connection_closed',
            run: cleanup,
            timeoutMessage: 'client close timed out',
          },
        ],
      })
    ).rejects.toBe(bodyFailure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('fails the test when cleanup fails after the body succeeds', async () => {
    const cleanupFailure = new Error('unexpected connection.closed rejection');

    await expect(
      runRemoteFilesystemQualificationCleanup({
        deadlineAt: 2_000,
        operations: [
          {
            phase: 'client_connection_closed',
            run: async () => {
              throw cleanupFailure;
            },
            timeoutMessage: 'client close timed out',
          },
        ],
      })
    ).rejects.toMatchObject({
      name: 'AcpCleanupError',
      phase: 'client_connection_closed',
      cause: cleanupFailure,
    });
  });

  it('aggregates the body failure before cleanup failures in a fixed order', async () => {
    const bodyFailure = new Error('body failed');
    const cleanupFailure = new Error('unexpected connection.closed rejection');

    await expect(
      runRemoteFilesystemQualificationCleanup({
        bodyError: bodyFailure,
        deadlineAt: 2_000,
        operations: [
          {
            phase: 'client_connection_closed',
            run: async () => {
              throw cleanupFailure;
            },
            timeoutMessage: 'client close timed out',
          },
        ],
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(bodyFailure);
      expect(aggregate.errors[1]).toBeInstanceOf(AcpCleanupError);
      expect(aggregate.errors[1]).toMatchObject({
        phase: 'client_connection_closed',
        cause: cleanupFailure,
      });
      return true;
    });
  });

  it('reports an unexpected connection.closed rejection as observable cleanup evidence', async () => {
    const cleanupFailure = new Error('transport closed unexpectedly');

    await expect(
      runRemoteFilesystemQualificationCleanup({
        deadlineAt: 2_000,
        operations: [
          {
            phase: 'agent_connection_closed',
            run: async () => {
              throw cleanupFailure;
            },
            timeoutMessage: 'agent close timed out',
          },
        ],
      })
    ).rejects.toMatchObject({
      name: 'AcpCleanupError',
      phase: 'agent_connection_closed',
      cause: cleanupFailure,
    });
  });

  it.each([
    new TypeError('Invalid state: WritableStream is closed'),
    Object.assign(new Error('WritableStream is closed'), {
      code: 'ERR_INVALID_STATE',
    }),
  ])('accepts only narrow benign writer-close errors: %s', (error) => {
    expect(isBenignPairedAcpWriterCloseError(error)).toBe(true);
    expect(
      isBenignPairedAcpWriterCloseError(new Error('transport closed unexpectedly'))
    ).toBe(false);
  });

  it('produces a stable canonical digest while excluding volatile paths and ids', () => {
    const first = buildCanonicalRemoteFilesystemQualificationEvidence({
      qualificationId: 'deepseek:deepseek-v4-flash',
      frameworkRetryBudget: 0,
      sourcePath: '/tmp/run-a/workspace/inputs/source.txt',
      outputPath: '/tmp/run-a/workspace/remote/out.txt',
      requests: [
        { kind: 'read', path: '/tmp/run-a/workspace/inputs/source.txt' },
        { kind: 'read', path: '/tmp/run-a/workspace/remote/out.txt' },
        { kind: 'write', path: '/tmp/run-a/workspace/remote/out.txt' },
        { kind: 'read', path: '/tmp/run-a/workspace/remote/out.txt' },
      ],
      writeResultCount: 1,
      hostSourcePreserved: true,
      hostOutputParentAbsent: true,
      outputContainsFinalMarker: true,
      outputExcludesHostCanary: true,
    });
    const second = buildCanonicalRemoteFilesystemQualificationEvidence({
      qualificationId: 'deepseek:deepseek-v4-flash',
      frameworkRetryBudget: 0,
      sourcePath: '/tmp/run-b/other/inputs/source.txt',
      outputPath: '/tmp/run-b/other/remote/out.txt',
      requests: [
        { kind: 'read', path: '/tmp/run-b/other/inputs/source.txt' },
        { kind: 'read', path: '/tmp/run-b/other/remote/out.txt' },
        { kind: 'write', path: '/tmp/run-b/other/remote/out.txt' },
        { kind: 'read', path: '/tmp/run-b/other/remote/out.txt' },
      ],
      writeResultCount: 1,
      hostSourcePreserved: true,
      hostOutputParentAbsent: true,
      outputContainsFinalMarker: true,
      outputExcludesHostCanary: true,
    });

    expect(first.requestSequence).toEqual([
      'read:source',
      'read:output',
      'write:output',
      'read:output',
    ]);
    expect(digestCanonicalRemoteFilesystemQualificationEvidence(first)).toBe(
      digestCanonicalRemoteFilesystemQualificationEvidence(second)
    );
    expect(digestCanonicalRemoteFilesystemQualificationEvidence(first)).toMatch(
      /^[a-f0-9]{64}$/
    );
  });
});
