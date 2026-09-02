import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');
vi.unmock('child_process');

import { AcpFileSystemService } from '../../../../src/acp/AcpFileSystemService.js';
import {
  createAcpRemotePathProfile,
  parseAcpRemotePath,
} from '../../../../src/acp/AcpRemotePath.js';
import { createAcpRemoteWorkspaceDescriptor } from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  AcpServiceContext,
  getAcpFileSystemService,
  getTerminalService,
  isAcpMode,
  isAcpRemoteFileSystem,
  isExplicitUnknownAcpSession,
} from '../../../../src/acp/AcpServiceContext.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import { ControlledTerminalClient } from '../../../support/acp/ControlledTerminalClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';

const capabilities: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

describe('AcpServiceContext session isolation', () => {
  const harnesses: PairedAcpHarness[] = [];

  afterEach(async () => {
    AcpServiceContext.destroySession('session-a');
    AcpServiceContext.destroySession('session-b');
    AcpServiceContext.destroySession('unknown-session');
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('resolves file and terminal services by session through paired SDK connections', async () => {
    const clientA = new ControlledTerminalClient();
    const clientB = new ControlledTerminalClient();
    const harnessA = createPairedAcpHarness(clientA);
    const harnessB = createPairedAcpHarness(clientB);
    harnesses.push(harnessA, harnessB);
    clientA.enqueueOutput({ output: 'a:session-a:/workspace/a', truncated: false });
    clientA.enqueueOutput({ output: 'a:session-a:/workspace/a', truncated: false });
    clientA.resolveWait({ exitCode: 0 });

    AcpServiceContext.initializeSession(
      harnessA.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );
    AcpServiceContext.initializeSession(
      harnessB.agentConnection,
      'session-b',
      capabilities,
      '/workspace/b'
    );
    AcpServiceContext.setCurrentSession('session-b');

    await expect(
      getAcpFileSystemService('session-a').readTextFile('/workspace/a/file.ts')
    ).resolves.toBe('controlled:session-a:/workspace/a/file.ts');
    await expect(
      getAcpFileSystemService('session-b').readTextFile('/workspace/b/file.ts')
    ).resolves.toBe('controlled:session-b:/workspace/b/file.ts');

    await expect(
      getTerminalService('session-a').execute('git status', { cwd: '/workspace/a' })
    ).resolves.toMatchObject({
      success: true,
      stdout: 'a:session-a:/workspace/a',
      transport: 'acp',
    });
    expect(clientA.createRequests).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        cwd: '/workspace/a',
      }),
    ]);
  });

  it('uses the local filesystem when fs capability is missing and preserves ACP mode', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { terminal: true },
      '/workspace/a'
    );

    const fileSystem = getAcpFileSystemService('session-a');
    await expect(fileSystem.exists('/definitely/missing')).resolves.toBe(false);
    expect(client.requests).toEqual([]);
    expect(isAcpMode('session-a')).toBe(true);
    expect(isAcpRemoteFileSystem('session-a')).toBe(false);
  });

  it('uses the local filesystem when fs capabilities are all false', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: false, writeTextFile: false } },
      '/workspace/a'
    );

    const fileSystem = getAcpFileSystemService('session-a');
    await expect(fileSystem.exists('/definitely/missing')).resolves.toBe(false);
    expect(client.requests).toEqual([]);
    expect(isAcpMode('session-a')).toBe(true);
    expect(isAcpRemoteFileSystem('session-a')).toBe(false);
  });

  it.each([
    {
      label: 'read-only',
      fs: { readTextFile: true, writeTextFile: false },
    },
    {
      label: 'write-only',
      fs: { readTextFile: false, writeTextFile: true },
    },
    {
      label: 'read-write',
      fs: { readTextFile: true, writeTextFile: true },
    },
  ])('uses the ACP filesystem when capabilities are $label', async ({ fs }) => {
    const client = new ControlledFileClient();
    client.files.set('/workspace/a/file.ts', 'remote content');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs },
      '/workspace/a'
    );

    const fileSystem = getAcpFileSystemService('session-a');
    if (fs.readTextFile) {
      await expect(fileSystem.readTextFile('/workspace/a/file.ts')).resolves.toBe(
        'remote content'
      );
      expect(client.requests).toEqual([
        {
          kind: 'read',
          request: {
            path: '/workspace/a/file.ts',
            sessionId: 'session-a',
          },
        },
      ]);
    } else {
      await expect(
        fileSystem.writeTextFile('/workspace/a/file.ts', 'remote write')
      ).resolves.toBeUndefined();
      expect(client.requests).toEqual([
        {
          kind: 'write',
          request: {
            path: '/workspace/a/file.ts',
            content: 'remote write',
            sessionId: 'session-a',
          },
        },
      ]);
    }

    expect(isAcpRemoteFileSystem('session-a')).toBe(true);
    expect(isAcpMode('session-a')).toBe(true);
  });

  it('ignores duplicate initializeSession calls so frozen filesystem ownership stays intact', async () => {
    const remoteClient = new ControlledFileClient();
    remoteClient.files.set('/workspace/a/file.ts', 'remote content');
    const replacementClient = new ControlledFileClient();
    const remoteHarness = createPairedAcpHarness(remoteClient);
    const replacementHarness = createPairedAcpHarness(replacementClient);
    harnesses.push(remoteHarness, replacementHarness);
    const initialCapabilities: acp.ClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    };

    AcpServiceContext.initializeSession(
      remoteHarness.agentConnection,
      'session-a',
      initialCapabilities,
      '/workspace/a'
    );

    const initialServices = AcpServiceContext.getSessionServices('session-a');
    expect(initialServices).not.toBeNull();
    expect(initialServices?.fileSystemService).toBeInstanceOf(AcpFileSystemService);
    if (!(initialServices?.fileSystemService instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    initialServices.fileSystemService.recordRemoteAccess(
      '/workspace/a/file.ts',
      'alpha',
      'read'
    );

    AcpServiceContext.initializeSession(
      replacementHarness.agentConnection,
      'session-a',
      { terminal: true },
      '/workspace/b'
    );

    const currentServices = AcpServiceContext.getSessionServices('session-a');
    expect(currentServices).toBe(initialServices);
    expect(currentServices?.connection).toBe(remoteHarness.agentConnection);
    expect(currentServices?.executionRoot).toBe('/workspace/a');
    expect(currentServices?.clientCapabilities).toEqual(initialCapabilities);
    expect(isAcpRemoteFileSystem('session-a')).toBe(true);
    expect(
      initialServices.fileSystemService.getRemoteAccessRecord('/workspace/a/file.ts')
    ).toBeDefined();
    await expect(
      getAcpFileSystemService('session-a').readTextFile('/workspace/a/file.ts')
    ).resolves.toBe('remote content');
    expect(remoteClient.requests).toEqual([
      {
        kind: 'read',
        request: {
          path: '/workspace/a/file.ts',
          sessionId: 'session-a',
        },
      },
    ]);
    expect(replacementClient.requests).toEqual([]);
  });

  it('keeps the first frozen remote path profile on duplicate initialize before fallback parsing', () => {
    const remoteClient = new ControlledFileClient();
    const replacementClient = new ControlledFileClient();
    const remoteHarness = createPairedAcpHarness(remoteClient);
    const replacementHarness = createPairedAcpHarness(replacementClient);
    harnesses.push(remoteHarness, replacementHarness);
    const initialProfile = createAcpRemotePathProfile('C:\\workspace');

    AcpServiceContext.initializeSession(
      remoteHarness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      'C:\\workspace',
      undefined,
      initialProfile
    );

    const firstServices = AcpServiceContext.getSessionServices('session-a');
    expect(firstServices?.fileSystemService).toBeInstanceOf(AcpFileSystemService);
    if (!(firstServices?.fileSystemService instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    AcpServiceContext.initializeSession(
      replacementHarness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      'C:relative\\workspace'
    );

    const secondServices = AcpServiceContext.getSessionServices('session-a');
    expect(secondServices).toBe(firstServices);
    expect(secondServices?.connection).toBe(remoteHarness.agentConnection);
    expect(secondServices?.executionRoot).toBe('C:\\workspace');
    expect(firstServices.fileSystemService.getPathProfile()).toEqual(initialProfile);
  });

  it('uses the current Session only when remote filesystem queries omit a session ID', () => {
    expect(isAcpRemoteFileSystem()).toBe(false);
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      '/workspace'
    );

    expect(isAcpRemoteFileSystem()).toBe(true);
    expect(isAcpRemoteFileSystem('unknown-session')).toBe(false);
    expect(isAcpMode('unknown-session')).toBe(false);
  });

  it('fails closed for an explicit unknown session terminal lookup instead of falling back locally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-unknown-session-'));
    const marker = join(directory, 'marker');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`
    )}`;

    try {
      await expect(
        getTerminalService('unknown-session').execute(command, { cwd: directory })
      ).resolves.toMatchObject({
        success: false,
        failureKind: 'unavailable',
        transport: 'acp',
      });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for an explicit unknown session filesystem lookup', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      '/workspace'
    );
    const fileSystem = getAcpFileSystemService('unknown-session');

    await expect(fileSystem.exists('/tmp/host-file')).rejects.toMatchObject({
      name: 'AcpFileSystemUnavailableError',
      code: 'acp_session_unavailable',
      message: 'ACP session filesystem is unavailable',
    });
    expect(client.requests).toEqual([]);
  });

  it('keeps no-session filesystem lookup local when ACP has no active session', async () => {
    await expect(
      getAcpFileSystemService().exists('/definitely/missing-without-acp')
    ).resolves.toBe(false);
  });

  it('disposes session-scoped remote ledger state when the session is destroyed', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      '/workspace/a'
    );

    const fileSystem = getAcpFileSystemService('session-a');
    expect(fileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(fileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    fileSystem.recordRemoteAccess('/workspace/a.ts', 'alpha', 'read');
    expect(fileSystem.getRemoteAccessRecord('/workspace/a.ts')).toBeDefined();

    AcpServiceContext.destroySession('session-a');

    expect(fileSystem.getRemoteAccessRecord('/workspace/a.ts')).toBeUndefined();
  });

  it('creates a fresh remote ledger and profile after destroy plus rebuild', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstProfile = createAcpRemotePathProfile('C:\\workspace');
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      'C:\\workspace',
      undefined,
      firstProfile
    );

    const firstFileSystem = getAcpFileSystemService('session-a');
    expect(firstFileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(firstFileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    firstFileSystem.recordRemoteAccess('C:\\workspace\\a.ts', 'alpha', 'read');
    expect(firstFileSystem.getRemoteAccessRecord('C:\\workspace\\a.ts')).toBeDefined();

    AcpServiceContext.destroySession('session-a');

    const secondProfile = createAcpRemotePathProfile('/workspace/posix');
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      '/workspace/posix',
      undefined,
      secondProfile
    );

    const rebuiltFileSystem = getAcpFileSystemService('session-a');
    expect(rebuiltFileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(rebuiltFileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(rebuiltFileSystem).not.toBe(firstFileSystem);
    expect(
      rebuiltFileSystem.getRemoteAccessRecord('/workspace/posix/a.ts')
    ).toBeUndefined();
    expect(rebuiltFileSystem.getPathProfile()).toEqual(secondProfile);
  });

  it('preserves remote mutation quarantine across destroy and rebuild on the same connection but clears it on connection close', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      '/workspace/a'
    );

    const initialFileSystem = getAcpFileSystemService('session-a');
    expect(initialFileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(initialFileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    const initialLease = initialFileSystem.tryAcquireMutationLease([
      '/workspace/shared.ts',
    ]);
    initialLease.markUncertain(parseAcpRemotePath('/workspace/shared.ts'));
    initialLease.release();

    AcpServiceContext.destroySession('session-a');

    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      '/workspace/a'
    );

    const rebuiltFileSystem = getAcpFileSystemService('session-a');
    expect(rebuiltFileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(rebuiltFileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    await expect(
      Promise.resolve().then(() =>
        rebuiltFileSystem.tryAcquireMutationLease(['/workspace/shared.ts'])
      )
    ).rejects.toMatchObject({
      name: 'AcpRemoteFileBoundaryError',
      reason: 'busy',
      operation: 'write',
      dispatched: false,
      requestPending: false,
    });

    await harness.close();

    const replacementHarness = createPairedAcpHarness(client);
    harnesses.push(replacementHarness);
    AcpServiceContext.destroySession('session-a');
    AcpServiceContext.initializeSession(
      replacementHarness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      '/workspace/a'
    );

    const afterReconnectFileSystem = getAcpFileSystemService('session-a');
    expect(afterReconnectFileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(afterReconnectFileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }

    const recoveredLease = afterReconnectFileSystem.tryAcquireMutationLease([
      '/workspace/shared.ts',
    ]);
    expect(recoveredLease.isCurrent(parseAcpRemotePath('/workspace/shared.ts'))).toBe(
      true
    );
    recoveredLease.release();
  });

  it('snapshots session fs capabilities at initialization time', async () => {
    interface MutableClientCapabilities extends acp.ClientCapabilities {
      fs?: {
        readTextFile?: boolean;
        writeTextFile?: boolean;
      };
    }

    const client = new ControlledFileClient();
    client.files.set('/workspace/a/file.ts', 'remote content');
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const mutableCapabilities: MutableClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    };

    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      mutableCapabilities,
      '/workspace/a'
    );

    mutableCapabilities.fs = { readTextFile: false, writeTextFile: true };

    expect(isAcpRemoteFileSystem('session-a')).toBe(true);
    const fileSystem = getAcpFileSystemService('session-a');
    expect(fileSystem).toBeInstanceOf(Object);
    expect(fileSystem).toMatchObject({
      canReadTextFile: expect.any(Function),
      canWriteTextFile: expect.any(Function),
    });
    expect(fileSystem).toBeInstanceOf(AcpFileSystemService);
    if (!(fileSystem instanceof AcpFileSystemService)) {
      throw new Error('expected ACP remote filesystem service');
    }
    expect(fileSystem.canReadTextFile()).toBe(true);
    expect(fileSystem.canWriteTextFile()).toBe(false);
    await expect(fileSystem.readTextFile('/workspace/a/file.ts')).resolves.toBe(
      'remote content'
    );
  });

  it('projects an exact read-only remote surface owner snapshot', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const profile = createAcpRemotePathProfile('C:\\workspace');
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: true,
      },
      profile.workspace.wirePath,
      undefined,
      profile
    );

    const snapshot = AcpServiceContext.getRemoteSurfaceOwnerSnapshot(
      'session-a',
      descriptor
    );
    expect(snapshot).toEqual({
      connection: 'online',
      generation: expect.stringMatching(/^acp-owner-generation:/),
      readText: true,
      writeText: false,
      terminal: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain(profile.workspace.wirePath);
    expect(JSON.stringify(snapshot)).not.toContain(profile.workspace.exactIdentity);
  });

  it('projects a remote surface owner offline after its ACP connection closes', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const profile = createAcpRemotePathProfile('/workspace/a');
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      profile.workspace.wirePath,
      undefined,
      profile
    );

    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', descriptor)
    ).toMatchObject({ connection: 'online' });

    await harness.close();

    expect(harness.agentConnection.signal.aborted).toBe(true);
    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', descriptor)
    ).toEqual({ connection: 'offline' });
  });

  it('does not project an already closed ACP connection as an online owner', async () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const profile = createAcpRemotePathProfile('/workspace/a');
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);

    await harness.close();
    expect(harness.agentConnection.signal.aborted).toBe(true);

    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      profile.workspace.wirePath,
      undefined,
      profile
    );

    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', descriptor)
    ).toEqual({ connection: 'offline' });
  });

  it('keeps collision-only and unknown remote surface rows offline', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const acceptedProfile = createAcpRemotePathProfile('C:\\Repo\\Surface.ts');
    const collisionProfile = createAcpRemotePathProfile('c:\\repo\\surface.ts');
    const acceptedDescriptor = createAcpRemoteWorkspaceDescriptor(acceptedProfile);
    const collisionDescriptor = createAcpRemoteWorkspaceDescriptor(collisionProfile);
    expect(collisionDescriptor.collisionIdentity).toBe(
      acceptedDescriptor.collisionIdentity
    );
    expect(collisionDescriptor.exactIdentity).not.toBe(
      acceptedDescriptor.exactIdentity
    );
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      acceptedProfile.workspace.wirePath,
      undefined,
      acceptedProfile
    );

    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', collisionDescriptor)
    ).toEqual({ connection: 'offline' });
    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot(
        'unknown-session',
        acceptedDescriptor
      )
    ).toEqual({ connection: 'offline' });
  });

  it('removes the owner before destroy and fences a rebuilt generation', () => {
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const profile = createAcpRemotePathProfile('/workspace/a');
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      profile.workspace.wirePath,
      undefined,
      profile
    );
    const first = AcpServiceContext.getRemoteSurfaceOwnerSnapshot(
      'session-a',
      descriptor
    );
    expect(first.connection).toBe('online');
    if (first.connection !== 'online') throw new Error('expected online owner');

    AcpServiceContext.destroySession('session-a');
    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', descriptor)
    ).toEqual({ connection: 'offline' });

    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      profile.workspace.wirePath,
      undefined,
      profile
    );
    const rebuilt = AcpServiceContext.getRemoteSurfaceOwnerSnapshot(
      'session-a',
      descriptor
    );
    expect(rebuilt.connection).toBe('online');
    if (rebuilt.connection !== 'online') throw new Error('expected rebuilt owner');
    expect(rebuilt.generation).not.toBe(first.generation);
  });

  it('does not transfer online ownership to a duplicate Session ID in another exact workspace', () => {
    const acceptedClient = new ControlledFileClient();
    const duplicateClient = new ControlledFileClient();
    const acceptedHarness = createPairedAcpHarness(acceptedClient);
    const duplicateHarness = createPairedAcpHarness(duplicateClient);
    harnesses.push(acceptedHarness, duplicateHarness);
    const acceptedProfile = createAcpRemotePathProfile('C:\\Repo\\Surface.ts');
    const duplicateProfile = createAcpRemotePathProfile('c:\\repo\\surface.ts');
    const acceptedDescriptor = createAcpRemoteWorkspaceDescriptor(acceptedProfile);
    const duplicateDescriptor = createAcpRemoteWorkspaceDescriptor(duplicateProfile);
    AcpServiceContext.initializeSession(
      acceptedHarness.agentConnection,
      'session-a',
      { fs: { readTextFile: true } },
      acceptedProfile.workspace.wirePath,
      undefined,
      acceptedProfile
    );
    AcpServiceContext.initializeSession(
      duplicateHarness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      duplicateProfile.workspace.wirePath,
      undefined,
      duplicateProfile
    );

    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', acceptedDescriptor)
    ).toMatchObject({ connection: 'online', readText: true });
    expect(
      AcpServiceContext.getRemoteSurfaceOwnerSnapshot('session-a', duplicateDescriptor)
    ).toEqual({ connection: 'offline' });
  });

  it('fails closed without spawning locally when a remote filesystem Session has no terminal capability', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-local-session-'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { fs: { readTextFile: true, writeTextFile: true } },
      directory
    );

    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify("require('node:fs').writeFileSync('marker', 'ok')"),
    ].join(' ');
    try {
      await expect(
        getTerminalService('session-a').execute(command)
      ).resolves.toMatchObject({
        success: false,
        failureKind: 'unavailable',
        transport: 'acp',
      });
      await expect(access(join(directory, 'marker'))).rejects.toThrow();
      expect(client.createRequests).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes cumulative ACP output reads and exposes a merged bounded capture', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const outputChunks: string[] = [];
    const firstRead = client.enqueueBlockedOutput({ output: 'a', truncated: false });
    client.enqueueOutput({ output: 'ab', truncated: false });
    client.resolveWait({ exitCode: 0 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf ab', {
      onOutput: (output) => outputChunks.push(output),
    });
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(client.outputRequests).toHaveLength(1);
    expect(client.maxConcurrentOutputReads).toBe(1);
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(2));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      success: true,
      stdout: 'ab',
      stderr: '',
      transport: 'acp',
      capture: {
        terminalOutputMerged: true,
        stdout: { accountingComplete: true },
        stderr: { content: '', totalBytes: 0 },
      },
    });
    expect(client.maxConcurrentOutputReads).toBe(1);
    expect(outputChunks.join('')).toBe('ab');
  }, 5000);

  it('fails closed when local execution is pre-aborted', async () => {
    AcpServiceContext.destroySession('session-a');
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-pre-abort-'));
    const marker = join(directory, 'marker');
    const controller = new AbortController();
    controller.abort();
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(program),
    ].join(' ');

    try {
      await expect(
        getTerminalService().execute(command, { signal: controller.signal })
      ).resolves.toMatchObject({
        failureKind: 'aborted',
        transport: 'local',
        error: 'Command was terminated',
      });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves nonzero ACP output without classifying a terminal failure', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'nonzero-output',
      truncated: false,
    });
    client.enqueueOutput({ output: 'nonzero-output', truncated: false });
    client.resolveWait({ exitCode: 7 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('exit 7');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();

    const result = await execution;
    expect(result).toMatchObject({
      success: false,
      stdout: 'nonzero-output',
      exitCode: 7,
      transport: 'acp',
    });
    expect(result.failureKind).toBeUndefined();
  });

  it('rebuilds a complete final capture after poll output regresses', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'abcdef',
      truncated: false,
    });
    client.enqueueOutput({ output: 'abc', truncated: false });
    client.enqueueOutput({ output: 'complete', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf complete');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(2));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'complete',
      transport: 'acp',
      capture: {
        stdout: { totalBytes: 8, accountingComplete: true },
      },
    });
  });

  it('marks capture accounting incomplete when final ACP output is truncated', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'tail', truncated: true });
    client.enqueueOutput({ output: 'tail', truncated: true });
    client.resolveWait({ exitCode: 0 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('printf tail')
    ).resolves.toMatchObject({
      stdout: 'tail',
      stderr: '',
      capture: {
        terminalOutputMerged: true,
        stdout: { accountingComplete: false },
        stderr: { accountingComplete: false },
      },
    });
  });

  it('restores complete accounting when a failed poll is followed by a complete final read', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutputError(new Error('poll failed'));
    client.enqueueOutput({ output: 'recovered', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf recovered');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(1));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'recovered',
      capture: { stdout: { accountingComplete: true } },
    });
  });

  it('keeps the lower-bound poll capture when final ACP output read fails', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'lower-bound',
      truncated: false,
    });
    client.enqueueOutputError(new Error('final read failed'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf lower-bound');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    firstRead.release();
    await vi.waitFor(() => expect(client.outputRequests).toHaveLength(1));
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      stdout: 'lower-bound',
      capture: {
        stdout: { accountingComplete: false },
      },
    });
  });

  it('awaits kill, final output, and release before resolving timeout', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'after-kill', truncated: false });
    client.enqueueOutput({ output: 'after-kill', truncated: false });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('sleep 10', { timeout: 1 })
    ).resolves.toMatchObject({
      success: false,
      stdout: 'after-kill',
      error: 'Command timed out',
      failureKind: 'timeout',
      transport: 'acp',
    });
    expect(client.callOrder).toContain('kill');
    expect(client.callOrder).toContain('release');
    expect(client.callOrder.indexOf('kill')).toBeLessThan(
      client.callOrder.lastIndexOf('output')
    );
    expect(client.callOrder.lastIndexOf('output')).toBeLessThan(
      client.callOrder.indexOf('release')
    );
  });

  it('does not let a stalled ACP output read defeat terminal timeout cleanup', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const blocked = client.enqueueBlockedOutput({
      output: 'never-returned',
      truncated: false,
    });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('sleep 10', {
      timeout: 1,
    });

    await expect(execution).resolves.toMatchObject({
      success: false,
      stdout: '',
      failureKind: 'timeout',
      transport: 'acp',
      capture: {
        stdout: { accountingComplete: false },
      },
    });
    expect(client.killRequests).toHaveLength(1);
    expect(client.releaseRequests).toHaveLength(1);
    expect(client.maxConcurrentOutputReads).toBe(1);
    blocked.release();
  }, 10_000);

  it('does not classify a slow bounded ACP output response as stalled', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    const firstRead = client.enqueueBlockedOutput({
      output: 'slow-complete-output',
      truncated: false,
    });
    client.enqueueOutput({
      output: 'slow-complete-output',
      truncated: false,
    });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('printf slow');
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    firstRead.release();
    await vi.waitFor(() => expect(client.activeOutputReads).toBe(0));
    client.resolveWait({ exitCode: 0 });

    await expect(execution).resolves.toMatchObject({
      success: true,
      stdout: 'slow-complete-output',
      capture: {
        stdout: { accountingComplete: true },
      },
    });
    expect(client.maxConcurrentOutputReads).toBe(1);
  }, 10_000);

  it('awaits kill, final output, and release before resolving an abort', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.enqueueOutput({ output: 'after-abort', truncated: false });
    client.enqueueOutput({ output: 'after-abort', truncated: false });
    const controller = new AbortController();
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    const execution = getTerminalService('session-a').execute('sleep 10', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      success: false,
      stdout: 'after-abort',
      error: 'Command was aborted',
      failureKind: 'aborted',
      transport: 'acp',
    });
    expect(client.callOrder.indexOf('kill')).toBeLessThan(
      client.callOrder.lastIndexOf('output')
    );
    expect(client.callOrder.lastIndexOf('output')).toBeLessThan(
      client.callOrder.indexOf('release')
    );
  });

  it('fails closed when ACP terminal creation fails without an explicit fallback opt-in', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.failCreate(new Error('offline'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      '/workspace/a'
    );

    await expect(
      getTerminalService('session-a').execute('printf local')
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^ACP terminal unavailable:/),
      failureKind: 'unavailable',
      transport: 'acp',
    });
  });

  it('ignores local fallback opt-in for remote filesystem sessions', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.failCreate(new Error('offline'));
    const directory = await mkdtemp(join(tmpdir(), 'blade-acp-no-fallback-'));
    const marker = join(directory, 'marker');
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      capabilities,
      'C:\\workspace'
    );

    try {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`
      )}`;
      await expect(
        getTerminalService('session-a').execute(command, {
          cwd: directory,
          allowLocalFallback: true,
        })
      ).resolves.toMatchObject({
        success: false,
        failureKind: 'unavailable',
        transport: 'acp',
      });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps local fallback available for ACP-local sessions with explicit opt-in', async () => {
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    harnesses.push(harness);
    client.failCreate(new Error('offline'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      'session-a',
      { terminal: true },
      '/workspace/a'
    );

    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify("process.stdout.write('local-fallback')"),
    ].join(' ');
    await expect(
      getTerminalService('session-a').execute(command, {
        allowLocalFallback: true,
      })
    ).resolves.toMatchObject({
      success: true,
      stdout: 'local-fallback',
      transport: 'local_fallback',
    });
  });

  it('bounds local split output and classifies timeout and abort separately', async () => {
    AcpServiceContext.destroySession('session-a');
    const service = getTerminalService();
    const oversized = 1024 * 1024 + 64;
    const outputProgram =
      `process.stdout.write('o'.repeat(${oversized}));` +
      `process.stderr.write('e'.repeat(${oversized}))`;
    const foreverProgram = 'setInterval(() => {}, 1_000)';
    const command = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(outputProgram),
    ].join(' ');
    const forever = [
      JSON.stringify(process.execPath),
      '-e',
      JSON.stringify(foreverProgram),
    ].join(' ');

    await expect(service.execute(command)).resolves.toMatchObject({
      success: true,
      transport: 'local',
      capture: {
        terminalOutputMerged: false,
        stdout: { totalBytes: oversized, omittedBytes: 64 },
        stderr: { totalBytes: oversized, omittedBytes: 64 },
      },
    });
    await expect(service.execute(forever, { timeout: 1 })).resolves.toMatchObject({
      success: false,
      error: 'Command was terminated',
      failureKind: 'timeout',
      transport: 'local',
    });
    const controller = new AbortController();
    const aborted = service.execute(forever, { signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({
      success: false,
      error: 'Command was terminated',
      failureKind: 'aborted',
      transport: 'local',
    });
  });
});
