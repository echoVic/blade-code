import { createHash } from 'node:crypto';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLease } from '../../../../src/agent/runtime/SessionLease.js';
import { getProjectStoragePath } from '../../../../src/context/storage/pathUtils.js';

describe('SessionLease', () => {
  let storageRoot: string;
  let projectPath: string;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-session-lease-'));
    projectPath = path.join(storageRoot, 'workspace');
    mkdirSync(projectPath, { recursive: true });
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
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
});
