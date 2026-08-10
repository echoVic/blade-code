import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpToolArtifactStore } from '../../../../src/mcp/McpToolArtifactStore.js';

describe('MCP tool artifact store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-artifacts-'));
  });

  afterEach(async () => {
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
