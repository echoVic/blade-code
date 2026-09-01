import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';
import { McpToolArtifactStore } from '../../../../src/mcp/McpToolArtifactStore.js';

describe('MCP tool artifact store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-artifacts-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('writes content-addressed artifacts with private permissions', async () => {
    const store = new McpToolArtifactStore('session-a', {
      storageRoot: root,
      exposePaths: true,
    });
    const bytes = Buffer.from('private MCP artifact');
    const first = await store.write({
      kind: 'text',
      bytes,
      mimeType: 'text/plain',
    });
    const second = await store.write({
      kind: 'text',
      bytes,
      mimeType: 'text/plain',
    });

    expect(first).toEqual(second);
    expect(first.persisted).toBe(true);
    expect(first.path).toMatch(/mcp-artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\.txt$/);
    const fileStats = await stat(first.path!);
    const sessionStats = await stat(path.dirname(first.path!));
    const artifactRootStats = await stat(path.dirname(path.dirname(first.path!)));
    expect(fileStats.mode & 0o777).toBe(0o600);
    expect(sessionStats.mode & 0o777).toBe(0o700);
    expect(artifactRootStats.mode & 0o777).toBe(0o700);
  });

  it('isolates Session roots and hides host paths for ACP-style callers', async () => {
    const local = new McpToolArtifactStore('session-a', {
      storageRoot: root,
      exposePaths: true,
    });
    const otherLocal = new McpToolArtifactStore('session-b', {
      storageRoot: root,
      exposePaths: true,
    });
    const remote = new McpToolArtifactStore('session-c', {
      storageRoot: root,
      exposePaths: false,
    });
    const request = {
      kind: 'image' as const,
      bytes: Buffer.from('image'),
      mimeType: 'image/png',
    };
    const localArtifact = await local.write(request);
    const otherLocalArtifact = await otherLocal.write(request);
    const remoteArtifact = await remote.write(request);

    expect(localArtifact.path).toBeDefined();
    expect(remoteArtifact.path).toBeUndefined();
    expect(localArtifact.id).toBe(remoteArtifact.id);
    expect(path.dirname(localArtifact.path!)).not.toBe(
      path.dirname(otherLocalArtifact.path!)
    );
  });

  it('revalidates the remote state scope before each artifact write', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/mcp-artifacts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const store = new McpToolArtifactStore('session-remote', {
      storageRoot: hostStateRoot,
      stateStorage: remoteStorage,
      exposePaths: true,
    });

    const first = await store.write({
      kind: 'text',
      bytes: Buffer.from('first'),
      mimeType: 'text/plain',
    });
    expect(first.path).toMatch(
      new RegExp(
        `^${hostStateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/mcp-artifacts/`
      )
    );

    await chmod(hostStateRoot, 0o755);
    await expect(
      store.write({
        kind: 'text',
        bytes: Buffer.from('second'),
        mimeType: 'text/plain',
      })
    ).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    await chmod(hostStateRoot, 0o700);
  });

  it('fails closed when an existing artifact loses private permissions', async () => {
    const store = new McpToolArtifactStore('session-a', {
      storageRoot: root,
      exposePaths: true,
    });
    const request = {
      kind: 'text' as const,
      bytes: Buffer.from('tamper target'),
      mimeType: 'text/plain',
    };
    const artifact = await store.write(request);
    await chmod(artifact.path!, 0o644);

    const reopened = new McpToolArtifactStore('session-a', {
      storageRoot: root,
      exposePaths: true,
    });
    await expect(reopened.write(request)).rejects.toThrow(
      /ownership or permissions|unsafe entry/
    );
  });

  it('rejects unsafe entries during store initialization', async () => {
    const unsafeRoot = path.join(root, 'mcp-artifacts');
    await writeFile(unsafeRoot, 'not-a-directory');
    const store = new McpToolArtifactStore('session-a', {
      storageRoot: root,
    });

    await expect(
      store.write({
        kind: 'text',
        bytes: Buffer.from('content'),
        mimeType: 'text/plain',
      })
    ).rejects.toThrow();
  });
});
