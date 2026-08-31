import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { PermissionMode } from '../../../src/config/types.js';
import {
  AcpCleanupError,
  buildCanonicalRemoteFilesystemQualificationEvidence,
  buildRemoteFilesystemQualificationRuntimeConfig,
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

  it('produces stable canonical evidence and digest across volatile roots', () => {
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
    expect(first.requestMethodOrder).toEqual([
      acp.CLIENT_METHODS.fs_read_text_file,
      acp.CLIENT_METHODS.fs_read_text_file,
      acp.CLIENT_METHODS.fs_write_text_file,
      acp.CLIENT_METHODS.fs_read_text_file,
    ]);
    expect(first.requestPathIdentities).toHaveLength(4);
    expect(first.requestPathIdentities[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.requestPathIdentities[1]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.requestPathIdentities[0]).not.toBe(first.requestPathIdentities[1]);
    expect(first.requestPathIdentities[1]).toBe(first.requestPathIdentities[2]);
    expect(digestCanonicalRemoteFilesystemQualificationEvidence(first)).toBe(
      digestCanonicalRemoteFilesystemQualificationEvidence(second)
    );
    expect(digestCanonicalRemoteFilesystemQualificationEvidence(first)).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it('records exact ACP method order without params and never serializes raw paths or secrets', () => {
    const sourcePath =
      '/tmp/volatile-root-a/workspace/inputs/source-secret-sentinel.txt';
    const outputPath =
      '/tmp/volatile-root-a/workspace/remote/output-secret-sentinel.txt';
    const evidence = buildCanonicalRemoteFilesystemQualificationEvidence({
      qualificationId: 'deepseek:deepseek-v4-pro',
      frameworkRetryBudget: 0,
      sourcePath,
      outputPath,
      requests: [
        { kind: 'read', path: sourcePath },
        { kind: 'read', path: outputPath },
        { kind: 'write', path: outputPath },
        { kind: 'read', path: outputPath },
      ],
      writeResultCount: 1,
      hostSourcePreserved: true,
      hostOutputParentAbsent: true,
      outputContainsFinalMarker: true,
      outputExcludesHostCanary: true,
    });

    expect(evidence.requestMethodOrder).toEqual([
      acp.CLIENT_METHODS.fs_read_text_file,
      acp.CLIENT_METHODS.fs_read_text_file,
      acp.CLIENT_METHODS.fs_write_text_file,
      acp.CLIENT_METHODS.fs_read_text_file,
    ]);
    for (const method of evidence.requestMethodOrder) {
      expect(method).not.toContain('{');
      expect(method).not.toContain(sourcePath);
      expect(method).not.toContain(outputPath);
    }

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(sourcePath);
    expect(serialized).not.toContain(outputPath);
    expect(serialized).not.toContain('volatile-root-a');
    expect(serialized).not.toContain('secret-sentinel');
    expect(serialized).not.toContain('HOST_CANARY_SECRET');
    expect(serialized).not.toContain('FINAL_MARKER_SECRET');
    expect(serialized).not.toContain('contentSha256');
  });

  it('forces model maxRetries=0 while preserving existing overrides', () => {
    const runtimeConfig = buildRemoteFilesystemQualificationRuntimeConfig({
      ...DEFAULT_CONFIG,
      currentModelId: 'selected-model',
      models: [
        {
          id: 'selected-model',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          overrides: {
            timeout: 180_000,
            streamIdleTimeout: 90_000,
            maxRetries: 7,
          },
        },
        {
          id: 'fallback-model',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
        },
      ],
      permissionMode: PermissionMode.DEFAULT,
      hooks: { enabled: true },
      disableAllHooks: false,
      mcpServers: {
        demo: {
          type: 'stdio',
          command: 'demo',
          timeout: 1_000,
        },
      },
    });

    expect(runtimeConfig.permissionMode).toBe(PermissionMode.YOLO);
    expect(runtimeConfig.hooks).toMatchObject({ enabled: false });
    expect(runtimeConfig.disableAllHooks).toBe(true);
    expect(runtimeConfig.mcpServers).toEqual({});
    expect(runtimeConfig.models).toHaveLength(2);
    expect(runtimeConfig.models[0].overrides).toMatchObject({
      timeout: 180_000,
      streamIdleTimeout: 90_000,
      maxRetries: 0,
    });
    expect(runtimeConfig.models[1].overrides).toEqual({ maxRetries: 0 });
  });
});
