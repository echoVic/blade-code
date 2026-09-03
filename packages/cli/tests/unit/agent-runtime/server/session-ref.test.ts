import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  normalizeLocalWorkspacePath,
  normalizeSessionRef,
  type SessionRef,
  sameSessionRef,
  sessionRefKey,
} from '../../../../src/server/sessionRef.js';

describe('sessionRef helpers', () => {
  let previousStorageRoot: string | undefined;
  let storageRoot: string;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-ref-storage-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('rejects invalid session ids before generating keys', () => {
    expect(() =>
      normalizeSessionRef({
        sessionId: '../escape',
        projectPath: '/tmp/workspace',
      })
    ).toThrow('Invalid session ID');
  });

  it('rejects relative project paths', () => {
    expect(() =>
      normalizeSessionRef({
        sessionId: 'session-1',
        projectPath: './relative-workspace',
      })
    ).toThrow('projectPath must be absolute');
  });

  it('rejects protected ACP remote host-state roots at local path boundaries', () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/workspace')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      descriptor.collisionIdentity,
      storageRoot
    );

    expect(() => normalizeLocalWorkspacePath(hostStateRoot)).toThrow(
      'projectPath must reference a local workspace'
    );
    expect(() =>
      normalizeLocalWorkspacePath(path.join(hostStateRoot, 'sessions'))
    ).toThrow('projectPath must reference a local workspace');
    expect(() => normalizeLocalWorkspacePath(path.dirname(hostStateRoot))).toThrow(
      'projectPath must reference a local workspace'
    );
    expect(
      normalizeLocalWorkspacePath(path.join(storageRoot, 'projects', 'local'))
    ).toBe(path.join(storageRoot, 'projects', 'local'));
    expect(
      normalizeSessionRef({ sessionId: 'session-1', projectPath: hostStateRoot })
    ).toEqual({ sessionId: 'session-1', projectPath: hostStateRoot });
  });

  it('normalizes absolute paths consistently', () => {
    const projectPath = path.join('/tmp', 'workspace', '..', 'workspace', '.');

    expect(normalizeSessionRef({ sessionId: 'session-1', projectPath })).toEqual({
      sessionId: 'session-1',
      projectPath: path.resolve('/tmp/workspace'),
    });
  });

  it('treats equivalent normalized refs as equal', () => {
    const left: SessionRef = {
      sessionId: 'session-1',
      projectPath: '/tmp/a/../workspace',
    };
    const right: SessionRef = {
      sessionId: 'session-1',
      projectPath: '/tmp/workspace',
    };

    expect(sameSessionRef(left, right)).toBe(true);
  });

  it('generates different keys for the same session id in different workspaces', () => {
    const left = sessionRefKey({
      sessionId: 'shared-id',
      projectPath: '/tmp/workspace-a',
    });
    const right = sessionRefKey({
      sessionId: 'shared-id',
      projectPath: '/tmp/workspace-b',
    });

    expect(left).not.toBe(right);
  });

  it('uses an unambiguous JSON array key encoding', () => {
    const ref: SessionRef = {
      sessionId: 'session.with-delimiters',
      projectPath: '/tmp/workspace-with|delimiters',
    };

    expect(sessionRefKey(ref)).toBe(
      JSON.stringify([path.resolve(ref.projectPath), ref.sessionId])
    );
  });
});
