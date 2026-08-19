import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLease } from '../../../../src/agent/runtime/SessionLease.js';
import { getProjectStoragePath } from '../../../../src/context/storage/pathUtils.js';

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
