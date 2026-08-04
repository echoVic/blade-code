import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionGoalFilePath } from '../../../../src/context/storage/pathUtils.js';
import { GoalStore } from '../../../../src/goals/GoalStore.js';

describe('GoalStore', () => {
  let storageRoot: string;
  let workspaceRoot: string;
  const sessionId = 'goal-session';

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-goal-store-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('creates an active goal atomically and restores it after restart', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({
      objective: '  finish the migration  ',
      tokenBudget: 2_000,
    });

    expect(created).toMatchObject({
      sessionId,
      objective: 'finish the migration',
      status: 'active',
      tokenBudget: 2_000,
      tokensUsed: 0,
      continuationCount: 0,
    });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toEqual(
      created
    );

    const filePath = getSessionGoalFilePath(workspaceRoot, sessionId);
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(created);
  });

  it('rejects a second unfinished goal and allows replacement after completion', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'first objective' });

    await expect(store.create({ objective: 'second objective' })).rejects.toThrow(
      'unfinished goal'
    );

    await store.complete();
    await expect(
      store.create({ objective: 'second objective' })
    ).resolves.toMatchObject({
      objective: 'second objective',
      status: 'active',
      tokensUsed: 0,
    });
  });

  it('supports pause, resume, edit, block, and clear transitions', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'initial objective' });

    await expect(store.pause()).resolves.toMatchObject({ status: 'paused' });
    await expect(store.pauseIfActive('turn failed')).resolves.toMatchObject({
      status: 'paused',
      statusReason: 'paused by user',
    });
    await expect(store.tryBeginContinuation()).resolves.toBeNull();
    await expect(store.resume()).resolves.toMatchObject({ status: 'active' });
    await expect(store.edit('revised objective')).resolves.toMatchObject({
      objective: 'revised objective',
      status: 'active',
    });
    await expect(store.block('waiting for credentials')).resolves.toMatchObject({
      status: 'blocked',
      statusReason: 'waiting for credentials',
    });
    await expect(store.resume()).resolves.toMatchObject({ status: 'active' });
    await expect(store.clear()).resolves.toBe(true);
    await expect(store.get()).resolves.toBeNull();
  });

  it('accounts usage and stops an active goal at its token budget', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'bounded objective', tokenBudget: 100 });
    await store.beginContinuation();

    await expect(
      store.recordProgress({ tokens: 40, elapsedMs: 1_600 })
    ).resolves.toMatchObject({
      status: 'active',
      tokensUsed: 40,
      timeUsedSeconds: 2,
      continuationCount: 1,
    });
    await expect(
      store.recordProgress({ tokens: 60, elapsedMs: 400 })
    ).resolves.toMatchObject({
      status: 'budget_limited',
      tokensUsed: 100,
      timeUsedSeconds: 2,
      statusReason: 'token budget exhausted',
    });
    await expect(store.beginContinuation()).rejects.toThrow('budget_limited');
  });

  it('fails closed on corrupt or mismatched persisted state', async () => {
    const filePath = getSessionGoalFilePath(workspaceRoot, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{not-json', { encoding: 'utf8', mode: 0o644 });

    await expect(new GoalStore(workspaceRoot, sessionId).get()).rejects.toThrow(
      'Invalid goal state JSON'
    );

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        sessionId: 'different-session',
        goalId: 'goal-1',
        objective: 'objective',
        status: 'active',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    await chmod(filePath, 0o644);
    await expect(new GoalStore(workspaceRoot, sessionId).get()).rejects.toThrow(
      'Invalid goal state'
    );
    await expect(new GoalStore(workspaceRoot, sessionId).clear()).resolves.toBe(true);
  });

  it('serializes concurrent creation and emits committed snapshots', async () => {
    const events: string[] = [];
    const unsubscribe = GoalStore.subscribe((event) => {
      if (event.sessionId === sessionId && event.goal) {
        events.push(event.goal.objective);
      }
    });
    const first = new GoalStore(workspaceRoot, sessionId);
    const second = new GoalStore(workspaceRoot, sessionId);

    const results = await Promise.allSettled([
      first.create({ objective: 'first' }),
      second.create({ objective: 'second' }),
    ]);
    unsubscribe();

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('does not report a committed write as failed when an observer throws', async () => {
    const unsubscribe = GoalStore.subscribe(() => {
      throw new Error('observer failed');
    });
    const store = new GoalStore(workspaceRoot, sessionId);

    await expect(store.create({ objective: 'committed goal' })).resolves.toMatchObject({
      objective: 'committed goal',
      status: 'active',
    });
    unsubscribe();
    await expect(store.get()).resolves.toMatchObject({
      objective: 'committed goal',
    });
  });
});
