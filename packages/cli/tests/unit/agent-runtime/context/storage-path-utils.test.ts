import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  assertValidSessionId,
  getAcpRemoteSessionFilePath,
  getAcpRemoteSessionGoalFilePath,
  getAcpRemoteSessionInboxFilePath,
  getAcpRemoteSessionStoragePath,
  getBladeStorageRoot,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionInboxFilePath,
  getSessionStoragePath,
  listProjectDirectories,
  listSessionStorageScopes,
} from '../../../../src/context/storage/pathUtils.js';

const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

afterEach(() => {
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe('context storage paths', () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-storage-paths-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('supports an isolated storage root for sandboxed runtimes', () => {
    process.env.BLADE_STORAGE_ROOT = '/tmp/blade-isolated';

    expect(getBladeStorageRoot()).toBe('/tmp/blade-isolated');
    expect(getProjectStoragePath('/workspace/demo')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo'
    );
    expect(getSessionFilePath('/workspace/demo', 'session-1')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo/session-1.jsonl'
    );
    expect(getSessionInboxFilePath('/workspace/demo', 'session-1')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo/session-1.inbox.json'
    );
  });

  it('rejects session IDs that can escape project storage', () => {
    expect(() => assertValidSessionId('../outside')).toThrow('Invalid session ID');
    expect(() => getSessionFilePath('/workspace/demo', 'nested/session')).toThrow(
      'Invalid session ID'
    );
    expect(() => getSessionInboxFilePath('/workspace/demo', '..')).toThrow(
      'Invalid session ID'
    );
  });

  it('accepts the complete Nano ID alphabet without weakening path containment', () => {
    process.env.BLADE_STORAGE_ROOT = '/tmp/blade-isolated';
    expect(() => assertValidSessionId('_generated-session')).not.toThrow();
    expect(() => assertValidSessionId('-generated-session')).not.toThrow();
    expect(getSessionFilePath('/workspace/demo', '_generated-session')).toBe(
      '/tmp/blade-isolated/projects/-workspace-demo/_generated-session.jsonl'
    );
  });

  it('keeps generic path helpers local-only even when given a remote-looking string', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    expect(getProjectStoragePath('/workspace/demo')).toBe(
      path.join(storageRoot, 'projects', '-workspace-demo')
    );
    expect(getSessionStoragePath('/workspace/demo')).toBe(
      path.join(storageRoot, 'projects', '-workspace-demo')
    );
    const escapedRemote = hostStateRoot.replaceAll('/', '-');
    expect(getProjectStoragePath(hostStateRoot)).toBe(
      path.join(storageRoot, 'projects', escapedRemote)
    );
    expect(getSessionStoragePath(hostStateRoot)).toBe(
      path.join(storageRoot, 'projects', escapedRemote)
    );
    expect(getSessionFilePath(hostStateRoot, 'remote-session')).toBe(
      path.join(storageRoot, 'projects', escapedRemote, 'remote-session.jsonl')
    );
    expect(getSessionInboxFilePath(hostStateRoot, 'remote-session')).toBe(
      path.join(storageRoot, 'projects', escapedRemote, 'remote-session.inbox.json')
    );
  });

  it('routes dedicated remote storage helpers directly only inside a validated branded scope', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      expect(getAcpRemoteSessionStoragePath(scope)).toBe(hostStateRoot);
      expect(getAcpRemoteSessionFilePath(scope, 'remote-session')).toBe(
        path.join(hostStateRoot, 'remote-session.jsonl')
      );
      expect(getAcpRemoteSessionInboxFilePath(scope, 'remote-session')).toBe(
        path.join(hostStateRoot, 'remote-session.inbox.json')
      );
      expect(getAcpRemoteSessionGoalFilePath(scope, 'remote-session')).toBe(
        path.join(hostStateRoot, 'remote-session.goal.json')
      );
      return undefined;
    });
  });

  it('lists local and remote session storage scopes while hiding the remote namespace from project directories', async () => {
    const localProjectPath = '/workspace/demo';
    const localStoragePath = getProjectStoragePath(localProjectPath);
    await mkdir(localStoragePath, { recursive: true });

    const remoteA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const remoteRootA = deriveAcpRemoteHostStateRoot(remoteA.collisionIdentity);
    const remoteRootB = deriveAcpRemoteHostStateRoot(remoteB.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(remoteRootA);
    await ensureAcpRemoteHostStateRoot(remoteRootB);

    const remoteNamespace = path.join(storageRoot, 'acp-remote-workspaces');
    await mkdir(path.join(remoteNamespace, 'not-a-digest'), { recursive: true });
    await mkdir(
      path.join(
        remoteNamespace,
        'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcg'
      ),
      { recursive: true }
    );
    await symlink(
      localStoragePath,
      path.join(remoteNamespace, 'ignored-symlink-not-a-valid-digest')
    );

    expect(await listProjectDirectories()).toEqual(['-workspace-demo']);
    await expect(listSessionStorageScopes()).resolves.toEqual(
      expect.arrayContaining([
        {
          storagePath: localStoragePath,
          projectPath: localProjectPath,
          kind: 'local',
        },
        {
          storagePath: remoteRootA,
          projectPath: remoteRootA,
          kind: 'acp-remote',
        },
        {
          storagePath: remoteRootB,
          projectPath: remoteRootB,
          kind: 'acp-remote',
        },
      ])
    );
    const scopes = await listSessionStorageScopes();
    expect(scopes.some((scope) => scope.storagePath.includes('not-a-digest'))).toBe(
      false
    );
    expect(
      scopes.some(
        (scope) =>
          scope.storagePath ===
          path.join(remoteNamespace, 'ignored-symlink-not-a-valid-digest')
      )
    ).toBe(false);
  });

  it('propagates remote namespace validation failures instead of degrading them to an empty list', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(remoteRoot);

    const remoteNamespace = path.join(storageRoot, 'acp-remote-workspaces');
    if (process.platform === 'win32') {
      await rm(remoteNamespace, { recursive: true, force: true });
      await symlink(path.join(storageRoot, 'projects'), remoteNamespace);
    } else {
      await chmod(remoteNamespace, 0o755);
    }

    await expect(listSessionStorageScopes()).rejects.toThrow(/remote workspace/i);
  });
});
