import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { SessionLease } from '../../../../src/agent/runtime/SessionLease.js';
import {
  getAcpRemoteSessionLeaseFilePath,
  getProjectStoragePath,
} from '../../../../src/context/storage/pathUtils.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';

describe('SessionLease', () => {
  let storageRoot: string;
  let projectPath: string;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(childProcess.spawn);
  });

  async function waitForFile(
    filePath: string,
    child: ChildProcess,
    timeoutMs = 5_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const exited = once(child, 'exit').then(() => 'exit' as const);
    for (;;) {
      if (existsSync(filePath)) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Lease holder exited before ready');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Lease holder ready timeout');
      const outcome = await Promise.race([
        exited,
        new Promise<'tick'>((resolve) =>
          setTimeout(() => resolve('tick'), Math.min(25, remaining))
        ),
      ]);
      if (outcome === 'exit') throw new Error('Lease holder exited before ready');
    }
  }

  async function terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-session-lease-'));
    projectPath = path.join(storageRoot, 'workspace');
    mkdirSync(projectPath, { recursive: true });
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(async () => {
    await Promise.all(Array.from(children, terminateChild));
    children.clear();
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  function getLeasePath(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId).digest('hex');
    return path.join(getProjectStoragePath(projectPath), '.locks', `${digest}.lock`);
  }

  it('recovers a lease owned by a process that no longer exists', async () => {
    const sessionId = 'stale-session';
    const lockPath = getLeasePath(sessionId);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sessionId,
        ownerId: 'dead-owner',
        pid: 2_147_483_647,
        acquiredAt: '2026-01-01T00:00:00.000Z',
      })}\n`
    );

    const lease = await SessionLease.acquire(sessionId, projectPath);

    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('stores remote session leases directly inside a validated protected scope', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-lease-session';

    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const lockPath = getAcpRemoteSessionLeaseFilePath(scope, sessionId);
      const lease = await SessionLease.acquireRemote(sessionId, scope);
      expect(existsSync(lockPath)).toBe(true);
      await lease.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    expect(existsSync(getProjectStoragePath(hostStateRoot))).toBe(false);
  });

  it('revalidates the remote state scope before releasing a lease', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Lease')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-lease-release-gate';
    const stateStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);

    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const lease = await SessionLease.acquireForStorage(sessionId, stateStorage);
    chmodSync(hostStateRoot, 0o755);

    await expect(lease.release()).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    chmodSync(hostStateRoot, 0o700);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      expect(existsSync(getAcpRemoteSessionLeaseFilePath(scope, sessionId))).toBe(true);
    });
    await expect(lease.release()).resolves.toBeUndefined();
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      expect(existsSync(getAcpRemoteSessionLeaseFilePath(scope, sessionId))).toBe(
        false
      );
    });
  });

  it('rejects a symlinked remote session lease without following or deleting it', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'remote-symlink-lease';
    const outsideLease = path.join(storageRoot, 'outside-lease.json');
    const outsideContent = `${JSON.stringify({
      version: 1,
      sessionId,
      ownerId: 'outside-owner',
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`;
    writeFileSync(outsideLease, outsideContent);

    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const lockPath = getAcpRemoteSessionLeaseFilePath(scope, sessionId);
      symlinkSync(outsideLease, lockPath);

      await expect(SessionLease.acquireRemote(sessionId, scope)).rejects.toMatchObject({
        code: 'acp_remote_workspace_state_invalid',
      });
      expect(readFileSync(outsideLease, 'utf8')).toBe(outsideContent);
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  it('recovers a reused live PID when the process identity changed', async () => {
    const sessionId = 'reused-pid-session';
    const lockPath = getLeasePath(sessionId);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sessionId,
        ownerId: 'reused-owner',
        pid: process.pid,
        processIdentity: {
          platform: process.platform,
          fingerprint: '0'.repeat(64),
        },
        acquiredAt: '2026-01-01T00:00:00.000Z',
      })}\n`
    );

    const lease = await SessionLease.acquire(sessionId, projectPath);

    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('does not remove a replacement lease owned by another runtime', async () => {
    const sessionId = 'replacement-session';
    const lockPath = getLeasePath(sessionId);
    const original = await SessionLease.acquire(sessionId, projectPath);
    const replacementOwner = 'replacement-owner';
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sessionId,
        ownerId: replacementOwner,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`
    );

    await original.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toContain(replacementOwner);
  });

  it('enforces session ownership across processes and releases on child exit', async () => {
    const sessionId = 'cross-process-session';
    const readyPath = path.join(storageRoot, 'lease-holder.ready');
    const fixturePath = path.resolve(
      import.meta.dirname,
      '../../../fixtures/hold-session-lease.ts'
    );
    const child = spawn(
      process.env.BUN_EXEC_PATH ?? 'bun',
      [fixturePath, sessionId, projectPath, readyPath],
      {
        env: { ...process.env, BLADE_STORAGE_ROOT: storageRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.add(child);

    await waitForFile(readyPath, child);
    await expect(SessionLease.acquire(sessionId, projectPath)).rejects.toMatchObject({
      name: 'SessionInUseError',
      code: 'BLADE_SESSION_IN_USE',
    });

    const exited = once(child, 'exit');
    child.stdin?.end();
    await exited;
    children.delete(child);

    const replacement = await SessionLease.acquire(sessionId, projectPath);
    await replacement.release();
    expect(existsSync(getLeasePath(sessionId))).toBe(false);
  });
});
