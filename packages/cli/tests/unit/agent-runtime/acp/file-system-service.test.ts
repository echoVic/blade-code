import { createHash } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface LoggerSpy {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

const loggerSpy = vi.hoisted<LoggerSpy>(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: vi.fn(() => loggerSpy),
  LogCategory: {
    AGENT: 'AGENT',
  },
}));

import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
  isAcpResourceNotFoundError,
  normalizeAcpRemotePath,
} from '../../../../src/acp/AcpFileSystemService.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

describe('AcpFileSystemService remote ownership', () => {
  const harnesses: PairedAcpHarness[] = [];

  afterEach(async () => {
    loggerSpy.info.mockReset();
    loggerSpy.debug.mockReset();
    loggerSpy.warn.mockReset();
    loggerSpy.error.mockReset();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  function serializeWarnCalls(): string {
    return JSON.stringify(loggerSpy.warn.mock.calls);
  }

  it('fails closed instead of writing locally after an advertised remote failure', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const remoteWriteRejected = new RequestError(-32010, 'remote write rejected');
    const writeSpy = vi
      .spyOn(client, 'writeTextFile')
      .mockRejectedValueOnce(remoteWriteRejected);
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
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(client.requests).toEqual([]);
    expect(service.usesRemoteFiles()).toBe(true);
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

    expect(loggerSpy.warn).toHaveBeenCalledWith(
      '[AcpFileSystem] readTextFile ACP request failed'
    );
    expect(serializeWarnCalls()).not.toContain(sentinel);
    expect(serializeWarnCalls()).not.toContain('/remote/private.txt');
    expect(serializeWarnCalls()).not.toContain('"secret"');
  });

  it('redacts sensitive remote write errors from logs while rethrowing them', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const sentinel = 'SENTINEL_PRIVATE_REMOTE_WRITE';
    const remoteError = new RequestError(-32031, sentinel, {
      secret: sentinel,
      path: '/remote/private.txt',
    });
    vi.spyOn(client, 'writeTextFile').mockRejectedValueOnce(remoteError);
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

    expect(loggerSpy.warn).toHaveBeenCalledWith(
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
});
