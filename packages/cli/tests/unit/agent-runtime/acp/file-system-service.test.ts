import { createHash } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
  getAcpFileRequestCoordinator,
} from '../../../../src/acp/AcpFileRequestCoordinator.js';
import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
  isAcpResourceNotFoundError,
  normalizeAcpRemotePath,
} from '../../../../src/acp/AcpFileSystemService.js';
import { Logger } from '../../../../src/logging/Logger.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import {
  createPairedAcpAppHarness,
  createPairedAcpHarness,
  type PairedAcpAppHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

const infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
const debugSpy = vi
  .spyOn(Logger.prototype, 'debug')
  .mockImplementation(() => undefined);
const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const errorSpy = vi
  .spyOn(Logger.prototype, 'error')
  .mockImplementation(() => undefined);

describe('AcpFileSystemService remote ownership', () => {
  const harnesses: Array<PairedAcpHarness | PairedAcpAppHarness> = [];

  afterEach(async () => {
    infoSpy.mockClear();
    debugSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  function serializeWarnCalls(): string {
    return JSON.stringify(warnSpy.mock.calls);
  }

  it('fails closed instead of writing locally after an advertised remote failure', async () => {
    const remoteWriteRejected = new RequestError(-32010, 'remote write rejected');
    const clientApp = acp
      .client({ name: 'file-system-write-fail-closed-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
        throw remoteWriteRejected;
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const requestSpy = vi.spyOn(harness.agentConnection, 'request');
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });

    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toMatchObject(
      {
        name: 'RequestError',
        code: -32010,
        message: 'remote write rejected',
      }
    );
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(service.usesRemoteFiles()).toBe(true);
    requestSpy.mockRestore();
  });

  it('fails closed instead of reading a same-named local file after a remote failure', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const remoteReadRejected = new RequestError(-32011, 'remote read rejected');
    const readSpy = vi
      .spyOn(client, 'readTextFile')
      .mockRejectedValueOnce(remoteReadRejected);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    await expect(service.readTextFile('/remote/file.ts')).rejects.toMatchObject({
      name: 'RequestError',
      code: -32011,
      message: 'remote read rejected',
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(client.requests).toEqual([]);
  });

  it('throws a typed read capability error without issuing ACP requests', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {});

    await expect(service.readTextFile('/remote/file.ts')).rejects.toMatchObject({
      name: 'AcpFileSystemCapabilityError',
      message: 'ACP remote filesystem does not support readTextFile',
      operation: 'readTextFile',
    });
    await expect(service.exists('/remote/file.ts')).rejects.toMatchObject({
      name: 'AcpFileSystemCapabilityError',
      operation: 'readTextFile',
    });
    expect(client.requests).toEqual([]);
    expect(service.usesRemoteFiles()).toBe(false);
  });

  it('throws a typed write capability error without issuing ACP requests', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {});

    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toMatchObject(
      {
        name: 'AcpFileSystemCapabilityError',
        message: 'ACP remote filesystem does not support writeTextFile',
        operation: 'writeTextFile',
      }
    );
    expect(client.requests).toEqual([]);
  });

  it('throws typed capability errors for unsupported binary and directory operations', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
      writeTextFile: true,
    });

    await expect(service.readBinaryFile('/remote/file.bin')).rejects.toMatchObject({
      name: 'AcpFileSystemCapabilityError',
      operation: 'readBinaryFile',
    });
    await expect(service.stat('/remote/file.bin')).rejects.toMatchObject({
      name: 'AcpFileSystemCapabilityError',
      operation: 'stat',
    });
    await expect(service.mkdir('/remote/dir')).rejects.toMatchObject({
      name: 'AcpFileSystemCapabilityError',
      operation: 'mkdir',
    });
    expect(client.requests).toEqual([]);
  });

  it('returns true from exists when remote read succeeds', async () => {
    const client = new ControlledFileClient();
    client.files.set('/remote/file.ts', 'content');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    await expect(service.exists('/remote/file.ts')).resolves.toBe(true);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: '/remote/file.ts',
          sessionId: 'session-a',
        },
      },
    ]);
  });

  it('returns false from exists only for confirmed ACP not found errors', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    await expect(service.exists('/remote/missing.ts')).resolves.toBe(false);
    expect(client.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: '/remote/missing.ts',
          sessionId: 'session-a',
        },
      },
    ]);
  });

  it('rethrows permission timeout network and unknown exists failures instead of assuming true', async () => {
    const cases = [
      {
        thrown: new RequestError(-32020, 'Permission denied'),
        expected: { name: 'RequestError', code: -32020, message: 'Permission denied' },
      },
      {
        thrown: new RequestError(-32021, 'Request timed out'),
        expected: { name: 'RequestError', code: -32021, message: 'Request timed out' },
      },
      {
        thrown: new RequestError(-32022, 'Network disconnected'),
        expected: {
          name: 'RequestError',
          code: -32022,
          message: 'Network disconnected',
        },
      },
      {
        thrown: new Error('Unexpected decode failure'),
        expected: {
          name: 'RequestError',
          code: -32603,
          message: 'Internal error',
          data: { details: 'Unexpected decode failure' },
        },
      },
    ];

    for (const testCase of cases) {
      const client = new ControlledFileClient();
      const harness = createPairedAcpHarness(client);
      harnesses.push(harness);
      vi.spyOn(client, 'readTextFile').mockRejectedValueOnce(testCase.thrown);
      const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
        readTextFile: true,
      });

      await expect(service.exists('/remote/file.ts')).rejects.toMatchObject(
        testCase.expected
      );
      expect(client.requests).toEqual([]);
    }
  });

  it('recognizes bounded not-found errors and rejects unrelated errors', () => {
    expect(
      isAcpResourceNotFoundError(RequestError.resourceNotFound('/fixture/missing.txt'))
    ).toBe(true);
    expect(
      isAcpResourceNotFoundError(new RequestError(-32002, 'resource missing'))
    ).toBe(true);
    expect(isAcpResourceNotFoundError(new Error('No such file or directory'))).toBe(
      true
    );
    expect(isAcpResourceNotFoundError(new Error('Path does not exist'))).toBe(true);
    expect(isAcpResourceNotFoundError(new Error('Permission denied'))).toBe(false);
    expect(isAcpResourceNotFoundError({ code: -32002 })).toBe(false);
  });

  it('exports a typed capability error class', () => {
    const error = new AcpFileSystemCapabilityError('mkdir');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AcpFileSystemCapabilityError');
    expect(error.message).toBe('ACP remote filesystem does not support mkdir');
    expect(error.operation).toBe('mkdir');
  });

  it('redacts sensitive remote read errors from logs while rethrowing them', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const sentinel = 'SENTINEL_PRIVATE_REMOTE_READ';
    const remoteError = new RequestError(-32030, sentinel, {
      secret: sentinel,
      path: '/remote/private.txt',
    });
    vi.spyOn(client, 'readTextFile').mockRejectedValueOnce(remoteError);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    await expect(service.readTextFile('/remote/private.txt')).rejects.toMatchObject({
      name: 'RequestError',
      code: -32030,
      message: sentinel,
      data: {
        secret: sentinel,
        path: '/remote/private.txt',
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[AcpFileSystem] readTextFile ACP request failed'
    );
    expect(serializeWarnCalls()).not.toContain(sentinel);
    expect(serializeWarnCalls()).not.toContain('/remote/private.txt');
    expect(serializeWarnCalls()).not.toContain('"secret"');
  });

  it('redacts sensitive remote write errors from logs while rethrowing them', async () => {
    const sentinel = 'SENTINEL_PRIVATE_REMOTE_WRITE';
    const remoteError = new RequestError(-32031, sentinel, {
      secret: sentinel,
      path: '/remote/private.txt',
    });
    const clientApp = acp
      .client({ name: 'file-system-write-sanitize-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => {
        throw remoteError;
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });

    await expect(
      service.writeTextFile('/remote/private.txt', 'payload')
    ).rejects.toMatchObject({
      name: 'RequestError',
      code: -32031,
      message: sentinel,
      data: {
        secret: sentinel,
        path: '/remote/private.txt',
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[AcpFileSystem] writeTextFile ACP request failed'
    );
    expect(serializeWarnCalls()).not.toContain(sentinel);
    expect(serializeWarnCalls()).not.toContain('/remote/private.txt');
    expect(serializeWarnCalls()).not.toContain('"secret"');
  });

  it('snapshots constructor capabilities instead of sharing the caller reference', async () => {
    const client = new ControlledFileClient();
    client.files.set('/remote/file.ts', 'snapshot content');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const mutableCapabilities = {
      readTextFile: true,
      writeTextFile: false,
    };
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      mutableCapabilities
    );

    mutableCapabilities.readTextFile = false;
    mutableCapabilities.writeTextFile = true;

    expect(service.canReadTextFile()).toBe(true);
    expect(service.canWriteTextFile()).toBe(false);
    expect(service.usesRemoteFiles()).toBe(true);
    await expect(service.readTextFile('/remote/file.ts')).resolves.toBe(
      'snapshot content'
    );
    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toMatchObject(
      {
        name: 'AcpFileSystemCapabilityError',
        operation: 'writeTextFile',
      }
    );
  });

  it('returns a defensive copy from getCapabilities', async () => {
    const client = new ControlledFileClient();
    client.files.set('/remote/file.ts', 'snapshot content');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
      writeTextFile: false,
    });

    const exposed = service.getCapabilities();
    exposed.readTextFile = false;
    exposed.writeTextFile = true;

    expect(service.canReadTextFile()).toBe(true);
    expect(service.canWriteTextFile()).toBe(false);
    expect(service.getCapabilities()).toEqual({
      readTextFile: true,
      writeTextFile: false,
    });
    await expect(service.readTextFile('/remote/file.ts')).resolves.toBe(
      'snapshot content'
    );
    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toMatchObject(
      {
        name: 'AcpFileSystemCapabilityError',
        operation: 'writeTextFile',
      }
    );
  });

  it('normalizes POSIX and Windows absolute remote paths lexically', () => {
    expect(normalizeAcpRemotePath('/workspace/src/../src/file.ts')).toBe(
      '/workspace/src/file.ts'
    );
    expect(normalizeAcpRemotePath('c:/workspace/src/../file.ts')).toBe(
      'C:\\workspace\\file.ts'
    );
  });

  it('normalizes aliases to the same ledger key and rejects invalid absolute forms', () => {
    expect(normalizeAcpRemotePath('/workspace/./src/../file.ts')).toBe(
      '/workspace/file.ts'
    );
    expect(normalizeAcpRemotePath('c:\\workspace\\src\\..\\file.ts')).toBe(
      'C:\\workspace\\file.ts'
    );
    expect(() => normalizeAcpRemotePath('relative/file.ts')).toThrowError(
      /must be absolute/
    );
    expect(() => normalizeAcpRemotePath('\\\\server\\share\\file.ts')).toThrowError(
      /UNC paths are not supported/
    );
    expect(() => normalizeAcpRemotePath('//server/share/file.ts')).toThrowError(
      /UNC paths are not supported/
    );
  });

  it('tracks a session-scoped remote digest ledger without storing content', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
      writeTextFile: true,
    });

    service.recordRemoteAccess('/workspace/a.ts', 'alpha', 'read');

    expect(service.checkRemoteAccess('/workspace/a.ts', 'alpha')).toBe('current');
    expect(service.checkRemoteAccess('/workspace/a.ts', 'beta')).toBe('modified');
    expect(service.checkRemoteAccess('/workspace/missing.ts', 'alpha')).toBe('missing');
    expect(service.getRemoteAccessRecord('/workspace/a.ts')).toEqual({
      filePath: '/workspace/a.ts',
      accessTime: expect.any(Number),
      contentSha256: createHash('sha256').update('alpha').digest('hex'),
      sessionId: 'session-a',
      lastOperation: 'read',
      source: 'remote',
    });
    expect(
      JSON.stringify(service.getRemoteAccessRecord('/workspace/a.ts'))
    ).not.toContain('alpha');
  });

  it('returns defensive copies for ledger records', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    service.recordRemoteAccess('/workspace/a.ts', 'alpha', 'read');
    const record = service.getRemoteAccessRecord('/workspace/a.ts');
    expect(record).toBeDefined();
    if (!record) {
      throw new Error('expected ledger record');
    }

    record.filePath = '/workspace/changed.ts';
    record.contentSha256 = 'changed';
    record.sessionId = 'session-b';
    record.lastOperation = 'write';
    record.accessTime = -1;

    expect(service.getRemoteAccessRecord('/workspace/a.ts')).toEqual({
      filePath: '/workspace/a.ts',
      accessTime: expect.any(Number),
      contentSha256: createHash('sha256').update('alpha').digest('hex'),
      sessionId: 'session-a',
      lastOperation: 'read',
      source: 'remote',
    });
  });

  it('isolates ledger state across service instances with the same path', () => {
    const clientA = new ControlledFileClient();
    const clientB = new ControlledFileClient();
    const harnessA = createPairedAcpHarness(clientA);
    const harnessB = createPairedAcpHarness(clientB);
    harnesses.push(harnessA, harnessB);
    const serviceA = new AcpFileSystemService(harnessA.agentConnection, 'session-a', {
      readTextFile: true,
    });
    const serviceB = new AcpFileSystemService(harnessB.agentConnection, 'session-b', {
      readTextFile: true,
    });

    serviceA.recordRemoteAccess('/workspace/shared.ts', 'alpha', 'read');
    serviceB.recordRemoteAccess('/workspace/shared.ts', 'beta', 'read');

    expect(serviceA.checkRemoteAccess('/workspace/shared.ts', 'alpha')).toBe('current');
    expect(serviceA.checkRemoteAccess('/workspace/shared.ts', 'beta')).toBe('modified');
    expect(serviceB.checkRemoteAccess('/workspace/shared.ts', 'beta')).toBe('current');
    expect(serviceB.checkRemoteAccess('/workspace/shared.ts', 'alpha')).toBe(
      'modified'
    );
    expect(serviceA.getRemoteAccessRecord('/workspace/shared.ts')).toMatchObject({
      sessionId: 'session-a',
      contentSha256: createHash('sha256').update('alpha').digest('hex'),
    });
    expect(serviceB.getRemoteAccessRecord('/workspace/shared.ts')).toMatchObject({
      sessionId: 'session-b',
      contentSha256: createHash('sha256').update('beta').digest('hex'),
    });
  });

  it('does not record raw remote reads, writes, or exists preflights in the ledger', async () => {
    const client = new ControlledFileClient();
    client.files.set('/workspace/a.ts', 'alpha');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
      writeTextFile: true,
    });

    await expect(service.readTextFile('/workspace/a.ts')).resolves.toBe('alpha');
    await expect(service.exists('/workspace/a.ts')).resolves.toBe(true);
    await expect(
      service.writeTextFile('/workspace/b.ts', 'beta')
    ).resolves.toBeUndefined();

    expect(service.getRemoteAccessRecord('/workspace/a.ts')).toBeUndefined();
    expect(service.getRemoteAccessRecord('/workspace/b.ts')).toBeUndefined();
  });

  it('keeps active ledger entries via check-based LRU refresh and evicts the oldest stale record', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });

    for (let index = 0; index < 1024; index += 1) {
      service.recordRemoteAccess(
        `/workspace/file-${index}.ts`,
        `content-${index}`,
        'read'
      );
    }

    expect(service.checkRemoteAccess('/workspace/file-0.ts', 'content-0')).toBe(
      'current'
    );

    service.recordRemoteAccess('/workspace/file-1024.ts', 'content-1024', 'read');

    expect(service.getRemoteAccessRecord('/workspace/file-0.ts')).toBeDefined();
    expect(service.getRemoteAccessRecord('/workspace/file-1.ts')).toBeUndefined();
    expect(service.getRemoteAccessRecord('/workspace/file-1024.ts')).toBeDefined();
  });

  it('readTextFileForUser dispatches via request() with cancellationSignal and records the ledger on success', async () => {
    const clientApp = acp
      .client({ name: 'file-system-user-read-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async ({ params, signal }) => {
        expect(params).toEqual({
          path: '/workspace/user-read.ts',
          sessionId: 'session-a',
        });
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        return { content: 'user read content' };
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });
    const requestSpy = vi.spyOn(harness.agentConnection, 'request');

    await expect(service.readTextFileForUser('/workspace/user-read.ts')).resolves.toBe(
      'user read content'
    );

    expect(requestSpy).toHaveBeenCalledWith(
      acp.CLIENT_METHODS.fs_read_text_file,
      {
        path: '/workspace/user-read.ts',
        sessionId: 'session-a',
      },
      expect.objectContaining({
        cancellationSignal: expect.any(AbortSignal),
      })
    );
    expect(
      service.checkRemoteAccess('/workspace/user-read.ts', 'user read content')
    ).toBe('current');
  });

  it('readTextFileForUser clears the current session ledger on explicit not-found', async () => {
    const clientApp = acp
      .client({ name: 'file-system-user-read-not-found-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async ({ params }) => {
        throw RequestError.resourceNotFound(params.path);
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });
    service.recordRemoteAccess('/workspace/user-read.ts', 'stale content', 'read');

    await expect(
      service.readTextFileForUser('/workspace/user-read.ts')
    ).rejects.toMatchObject({
      name: 'RequestError',
      code: -32002,
    });
    expect(service.getRemoteAccessRecord('/workspace/user-read.ts')).toBeUndefined();
  });

  it('readTextFileForUser uses the default absolute deadline and settles locally on timeout', async () => {
    const releaseBlockedRead = Promise.withResolvers<void>();
    const clientApp = acp
      .client({ name: 'file-system-user-read-timeout-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async ({ signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        await releaseBlockedRead.promise;
        return { content: 'late content' };
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
    });
    vi.useFakeTimers({ now: 10_000 });
    try {
      const requestPromise = service.readTextFileForUser(
        '/workspace/user-read-timeout.ts'
      );
      const rejection = expect(requestPromise).rejects.toMatchObject({
        name: 'AcpRemoteFileBoundaryError',
        reason: 'timeout',
        operation: 'read',
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS + 1);
      await rejection;
      expect(
        service.getRemoteAccessRecord('/workspace/user-read-timeout.ts')
      ).toBeUndefined();

      releaseBlockedRead.resolve();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the no-options write compatibility call without bypassing mutation fencing', async () => {
    const blockedWrite = Promise.withResolvers<void>();
    let mode: 'ack' | 'error' | 'blocked' = 'ack';
    const clientApp = acp
      .client({ name: 'file-system-write-compat-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async ({ params, signal }) => {
        expect(params.sessionId).toBe('session-a');
        expect(signal).toBeInstanceOf(AbortSignal);
        if (mode === 'ack') {
          return {};
        }
        if (mode === 'error') {
          throw new RequestError(-32041, 'compat settled error');
        }
        await blockedWrite.promise;
        return {};
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const requestSpy = vi.spyOn(harness.agentConnection, 'request');

    await expect(
      service.writeTextFile('/workspace/compat-ack.ts', 'alpha')
    ).resolves.toBeUndefined();
    expect(requestSpy).toHaveBeenCalledWith(
      acp.CLIENT_METHODS.fs_write_text_file,
      {
        path: '/workspace/compat-ack.ts',
        content: 'alpha',
        sessionId: 'session-a',
      },
      expect.objectContaining({
        cancellationSignal: expect.any(AbortSignal),
      })
    );
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      pendingWrites: 0,
      needsRead: 0,
    });

    mode = 'error';
    await expect(
      service.writeTextFile('/workspace/compat-error.ts', 'beta')
    ).rejects.toMatchObject({
      name: 'RequestError',
      code: -32041,
      message: 'compat settled error',
    });
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      pendingWrites: 0,
      needsRead: 1,
    });
    const recoveryPermit = coordinator.beginUserRead(
      '/workspace/compat-error.ts',
      'session-a'
    );
    expect(recoveryPermit.lane).toBe('recovery');
    recoveryPermit.fail();

    mode = 'blocked';
    vi.useFakeTimers({ now: 20_000 });
    try {
      const pendingWrite = service.writeTextFile(
        '/workspace/compat-pending.ts',
        'gamma'
      );
      const pendingRejection = expect(pendingWrite).rejects.toMatchObject({
        name: 'AcpRemoteFileBoundaryError',
        reason: 'timeout',
        operation: 'write',
        dispatched: true,
        requestPending: true,
      });
      await Promise.resolve();
      await expect(
        service.writeTextFile('/workspace/compat-pending.ts', 'delta')
      ).rejects.toMatchObject({
        name: 'AcpRemoteFileBoundaryError',
        reason: 'busy',
        dispatched: false,
        requestPending: false,
      });
      await vi.advanceTimersByTimeAsync(ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS + 1);
      await pendingRejection;
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 1,
      });

      blockedWrite.resolve();
      await vi.runAllTimersAsync();
      expect(coordinator.getStatsForTests()).toMatchObject({
        pendingWrites: 0,
        needsRead: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a caller-owned write lease without reacquiring or releasing it', async () => {
    const clientApp = acp
      .client({ name: 'file-system-write-owned-lease-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const lease = coordinator.tryAcquireMutationLease(
      ['/workspace/caller-owned.ts'],
      'session-a'
    );
    const acquireLeaseSpy = vi.spyOn(coordinator, 'tryAcquireMutationLease');

    await expect(
      service.writeTextFile('/workspace/caller-owned.ts', 'owned', {
        deadlineAt: Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
        lease,
        purpose: 'mutation',
      })
    ).resolves.toBeUndefined();
    expect(acquireLeaseSpy).not.toHaveBeenCalled();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    lease.release();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
    });
    acquireLeaseSpy.mockRestore();
  });

  it('normalizes paths for mutation precheck and lease acquisition through service convenience methods', async () => {
    const clientApp = acp
      .client({ name: 'file-system-mutation-convenience-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      readTextFile: true,
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);

    expect(() =>
      service.precheckMutationPaths(['/workspace/dir/../shared.ts'])
    ).not.toThrow();

    const lease = service.tryAcquireMutationLease(['/workspace/./shared.ts']);
    expect(lease.generationFor('/workspace/shared.ts')).toBeGreaterThan(0);
    expect(lease.isCurrent('/workspace/shared.ts')).toBe(true);

    await expect(
      Promise.resolve().then(() =>
        service.tryAcquireMutationLease(['/workspace/shared.ts'])
      )
    ).rejects.toMatchObject({
      name: 'AcpRemoteFileBoundaryError',
      reason: 'busy',
      operation: 'write',
      dispatched: false,
      requestPending: false,
    });

    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 1,
      activeMutations: 1,
      pendingWrites: 0,
      needsRead: 0,
    });

    lease.release();
  });

  it('does not mark a no-options write as uncertain when aborted before dispatch', async () => {
    const clientApp = acp
      .client({ name: 'file-system-write-pre-dispatch-abort-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const requestSpy = vi.spyOn(harness.agentConnection, 'request');
    const controller = new AbortController();
    controller.abort(new DOMException('Aborted before dispatch', 'AbortError'));

    await expect(
      service.writeTextFile('/workspace/pre-dispatch-abort.ts', 'alpha', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      name: 'AcpRemoteFileBoundaryError',
      reason: 'aborted',
      operation: 'write',
      dispatched: false,
      requestPending: false,
    });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });
    requestSpy.mockRestore();
  });

  it('does not mark a no-options write as uncertain when the deadline is already expired before dispatch', async () => {
    const clientApp = acp
      .client({ name: 'file-system-write-expired-deadline-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });
    const coordinator = getAcpFileRequestCoordinator(harness.agentConnection);
    const requestSpy = vi.spyOn(harness.agentConnection, 'request');

    await expect(
      service.writeTextFile('/workspace/expired-deadline.ts', 'alpha', {
        deadlineAt: Date.now() - 1,
      })
    ).rejects.toMatchObject({
      name: 'AcpRemoteFileBoundaryError',
      reason: 'timeout',
      operation: 'write',
      dispatched: false,
      requestPending: false,
    });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(coordinator.getStatsForTests()).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });
    requestSpy.mockRestore();
  });

  it('does not log remote raw paths or payloads for task2 adapter operations', async () => {
    const clientApp = acp
      .client({ name: 'file-system-log-sanitize-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(harness.agentConnection, 'session-a', {
      writeTextFile: true,
    });
    const sentinelPath = '/remote/private/SENTINEL_WRITE.txt';
    const sentinelContent = 'SENTINEL_REMOTE_PAYLOAD';

    await expect(
      service.writeTextFile(sentinelPath, sentinelContent)
    ).resolves.toBeUndefined();
    await expect(service.readBinaryFile(sentinelPath)).rejects.toBeInstanceOf(
      AcpFileSystemCapabilityError
    );
    await expect(service.stat(sentinelPath)).rejects.toBeInstanceOf(
      AcpFileSystemCapabilityError
    );
    await expect(service.mkdir(sentinelPath)).rejects.toBeInstanceOf(
      AcpFileSystemCapabilityError
    );

    const debugCalls = JSON.stringify(debugSpy.mock.calls);
    const warnCalls = JSON.stringify(warnSpy.mock.calls);
    expect(debugCalls).not.toContain(sentinelPath);
    expect(debugCalls).not.toContain(sentinelContent);
    expect(warnCalls).not.toContain(sentinelPath);
    expect(warnCalls).not.toContain(sentinelContent);
  });
});
