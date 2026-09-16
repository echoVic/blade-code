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
import {
  type AcpRemotePathProfile,
  createAcpRemotePathProfile,
  parseAcpRemotePath,
} from '../../../../src/acp/AcpRemotePath.js';
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
const posixProfile = createAcpRemotePathProfile('/workspace');
const winProfile = createAcpRemotePathProfile('C:\\workspace');
const remoteProfile = createAcpRemotePathProfile('/remote');

describe('AcpFileSystemService remote ownership', () => {
  const harnesses: Array<PairedAcpHarness | PairedAcpAppHarness> = [];

  afterEach(async () => {
    infoSpy.mockClear();
    debugSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

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
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {
        writeTextFile: true,
      },
      remoteProfile
    );

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

  it('throws a typed read capability error without issuing ACP requests', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {},
      remoteProfile
    );

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
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {},
      remoteProfile
    );

    await expect(service.writeTextFile('/remote/file.ts', 'new')).rejects.toMatchObject(
      {
        name: 'AcpFileSystemCapabilityError',
        message: 'ACP remote filesystem does not support writeTextFile',
        operation: 'writeTextFile',
      }
    );
    expect(client.requests).toEqual([]);
  });

  it('returns false from exists only for confirmed ACP not found errors', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {
        readTextFile: true,
      },
      remoteProfile
    );

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
      const service = new AcpFileSystemService(
        harness.agentConnection,
        'session-a',
        {
          readTextFile: true,
        },
        remoteProfile
      );

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

  it('rejects forged parsed identities before requests, ledger updates, or mutation fencing', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      { readTextFile: true, writeTextFile: true },
      winProfile
    );
    const canonical = service.parsePath('C:\\workspace\\source.ts');
    const forged = Object.freeze({
      ...canonical,
      wirePath: 'C:\\workspace\\target.ts',
    });
    const forgedProfile = Object.freeze({
      ...winProfile,
      workspace: forged,
    });

    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(winProfile)).toBe(true);
    const assertIdentityError = (operation: () => unknown): void => {
      try {
        operation();
        throw new Error('expected canonical path identity rejection');
      } catch (error) {
        expect(error).toMatchObject({
          name: 'AcpRemotePathIdentityError',
          code: 'acp_remote_path_identity_invalid',
          message: 'ACP remote path identity is invalid',
        });
        expect(JSON.stringify(error)).not.toContain('source.ts');
        expect(JSON.stringify(error)).not.toContain('target.ts');
      }
    };
    assertIdentityError(
      () =>
        new AcpFileSystemService(
          harness.agentConnection,
          'forged-profile',
          { readTextFile: true, writeTextFile: true },
          forgedProfile
        )
    );
    assertIdentityError(() =>
      service.recordRemoteAccessForParsedPath(forged, 'forged', 'read')
    );
    await expect(
      service.readTextFileForUserForParsedPath(forged)
    ).rejects.toMatchObject({
      name: 'AcpRemotePathIdentityError',
      code: 'acp_remote_path_identity_invalid',
      message: 'ACP remote path identity is invalid',
    });
    assertIdentityError(() => service.checkRemoteAccessForParsedPath(forged, 'forged'));
    assertIdentityError(() => service.createOpaqueLockKeyForParsedPath(forged));
    assertIdentityError(() => service.precheckMutationPathsForParsedPaths([forged]));
    assertIdentityError(() => service.tryAcquireMutationLeaseForParsedPaths([forged]));
    for (const operation of [
      () => service.createOpaqueLockKeyForParsedPath(parseAcpRemotePath('/source.ts')),
      () =>
        service.precheckMutationPathsForParsedPaths([parseAcpRemotePath('/source.ts')]),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({
          name: 'AcpRemotePathError',
          code: 'acp_remote_path_invalid',
          reason: 'style-mismatch',
        })
      );
    }
    await expect(
      service.writeTextFileForParsedPath(forged, 'forged')
    ).rejects.toMatchObject({
      name: 'AcpRemotePathIdentityError',
      code: 'acp_remote_path_identity_invalid',
      message: 'ACP remote path identity is invalid',
    });

    expect(client.requests).toEqual([]);
    expect(service.getRemoteAccessRecord('C:\\workspace\\source.ts')).toBeUndefined();
    expect(service.getRemoteAccessRecord('C:\\workspace\\target.ts')).toBeUndefined();
    expect(
      getAcpFileRequestCoordinator(harness.agentConnection).getStatsForTests()
    ).toMatchObject({
      mutationPaths: 0,
      activeMutations: 0,
      pendingWrites: 0,
      needsRead: 0,
    });
  });

  it('keeps active ledger entries via check-based LRU refresh and evicts the oldest stale record', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {
        readTextFile: true,
      },
      posixProfile
    );

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

  it('readTextFileForUser clears the current session ledger on explicit not-found', async () => {
    const clientApp = acp
      .client({ name: 'file-system-user-read-not-found-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async ({ params }) => {
        throw RequestError.resourceNotFound(params.path);
      });
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {
        readTextFile: true,
      },
      posixProfile
    );
    service.recordRemoteAccess('/workspace/user-read.ts', 'stale content', 'read');

    await expect(
      service.readTextFileForUser('/workspace/user-read.ts')
    ).rejects.toMatchObject({
      name: 'RequestError',
      code: -32002,
    });
    expect(service.getRemoteAccessRecord('/workspace/user-read.ts')).toBeUndefined();
  });

  it('does not mark a no-options write as uncertain when aborted before dispatch', async () => {
    const clientApp = acp
      .client({ name: 'file-system-write-pre-dispatch-abort-client' })
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, async () => ({}));
    const harness = createPairedAcpAppHarness(clientApp);
    harnesses.push(harness);
    const service = new AcpFileSystemService(
      harness.agentConnection,
      'session-a',
      {
        writeTextFile: true,
      },
      posixProfile
    );
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
});
