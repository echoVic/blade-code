import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionGoalFilePath } from '../../../../src/context/storage/pathUtils.js';
import type { SessionGoalFinalizationInfo } from '../../../../src/context/types.js';
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

    await store.requestCompletion();
    await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-1',
      summary: 'All requirements verified.',
      evidenceSha256: '1'.repeat(64),
    });
    await store.finalizeVerifiedCompletion();
    await expect(
      store.create({ objective: 'second objective' })
    ).resolves.toMatchObject({
      objective: 'second objective',
      status: 'active',
      tokensUsed: 0,
    });
  });

  it('requires persisted independent PASS evidence before completion', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'ship verified output' });

    const candidate = await store.requestCompletion();
    expect(candidate).toMatchObject({
      status: 'verifying',
      statusReason: 'awaiting independent completion verification',
      completionVerification: {
        attempt: 1,
        status: 'pending',
      },
    });
    await expect(store.requestCompletion()).resolves.toEqual(candidate);
    await expect(store.finalizeVerifiedCompletion()).rejects.toThrow(
      'independent PASS'
    );
    await expect(
      store.recordCompletionVerification({
        verdict: 'pass',
        verifierSessionId: 'verifier-missing-digest',
      })
    ).rejects.toThrow('SHA-256');
    await expect(
      store.recordCompletionVerification({
        verdict: 'pass',
        evidenceSha256: 'a'.repeat(64),
      })
    ).rejects.toThrow('Session identity');

    await expect(
      store.recordCompletionVerification({
        verdict: 'fail',
        verifierSessionId: 'verifier-fail',
        summary: 'Missing required evidence.',
        evidenceSha256: 'f'.repeat(64),
      })
    ).resolves.toMatchObject({
      status: 'verifying',
      completionVerification: {
        attempt: 1,
        status: 'fail',
        verifierSessionId: 'verifier-fail',
      },
    });
    await expect(store.finalizeVerifiedCompletion()).rejects.toThrow(
      'independent PASS'
    );

    await expect(
      store.invalidateCompletionVerification('workspace changed')
    ).resolves.toMatchObject({
      status: 'verifying',
      statusReason: 'workspace changed',
      completionVerification: {
        attempt: 1,
        status: 'pending',
      },
    });
    await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-pass',
      summary: 'Observed the requested output.',
      evidenceSha256: 'a'.repeat(64),
    });
    const completed = await store.finalizeVerifiedCompletion();
    expect(completed).toMatchObject({
      status: 'complete',
      completionVerification: {
        attempt: 1,
        status: 'pass',
        verifierSessionId: 'verifier-pass',
        evidenceSha256: 'a'.repeat(64),
      },
    });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toEqual(
      completed
    );
  });

  it('accepts a fresh verifier PASS after incrementing a failed attempt', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'recover completion verification' });
    await store.requestCompletion();
    await store.recordCompletionVerification({
      verdict: 'fail',
      verifierSessionId: 'verifier-attempt-1',
      summary: 'The first verification found a gap.',
      evidenceSha256: '1'.repeat(64),
    });

    await expect(store.requestCompletion()).resolves.toMatchObject({
      status: 'verifying',
      completionVerification: {
        attempt: 2,
        status: 'pending',
      },
    });
    await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-attempt-2',
      summary: 'The recovered verification passed.',
      evidenceSha256: '2'.repeat(64),
    });

    await expect(store.finalizeVerifiedCompletion()).resolves.toMatchObject({
      status: 'complete',
      completionVerification: {
        attempt: 2,
        status: 'pass',
        verifierSessionId: 'verifier-attempt-2',
        evidenceSha256: '2'.repeat(64),
      },
    });
  });

  it('reconciles an exact durable finalization receipt idempotently', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'finish across a crash' });
    await store.requestCompletion();
    const passed = await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-final',
      summary: 'All requirements passed.',
      evidenceSha256: 'b'.repeat(64),
    });
    const receipt: SessionGoalFinalizationInfo = {
      goalId: created.goalId,
      verificationAttempt: passed.completionVerification!.attempt,
      verifierSessionId: 'verifier-final',
      evidenceSha256: 'b'.repeat(64),
      goalUpdatedAt: passed.updatedAt,
    };

    await expect(store.reconcileFinalizationReceipt(receipt)).resolves.toMatchObject({
      finalized: true,
      goal: {
        goalId: created.goalId,
        status: 'complete',
        completionVerification: {
          status: 'pass',
          verifierSessionId: 'verifier-final',
          evidenceSha256: 'b'.repeat(64),
        },
      },
    });
    await expect(store.reconcileFinalizationReceipt(receipt)).resolves.toMatchObject({
      finalized: false,
      goal: {
        goalId: created.goalId,
        status: 'complete',
      },
    });
  });

  it('ignores stale or mismatched durable finalization receipts', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'preserve fresh verification' });
    await store.requestCompletion();
    const passed = await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-current',
      evidenceSha256: 'c'.repeat(64),
    });
    const receipt: SessionGoalFinalizationInfo = {
      goalId: created.goalId,
      verificationAttempt: passed.completionVerification!.attempt,
      verifierSessionId: 'verifier-current',
      evidenceSha256: 'c'.repeat(64),
      goalUpdatedAt: passed.updatedAt,
    };

    await expect(
      store.reconcileFinalizationReceipt({
        ...receipt,
        evidenceSha256: 'd'.repeat(64),
      })
    ).resolves.toBeNull();
    await expect(
      store.reconcileFinalizationReceipt({
        ...receipt,
        goalUpdatedAt: new Date(Date.now() + 1000).toISOString(),
      })
    ).resolves.toBeNull();
    await expect(store.get()).resolves.toMatchObject({
      status: 'verifying',
      completionVerification: {
        status: 'pass',
        evidenceSha256: 'c'.repeat(64),
      },
    });

    await store.finalizeVerifiedCompletion();
    const replacement = await store.create({ objective: 'new goal' });
    await expect(store.reconcileFinalizationReceipt(receipt)).resolves.toBeNull();
    await expect(store.get()).resolves.toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
    });
  });

  it('resumes a paused verification candidate without trusting stale completion', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'verify after restart' });
    await store.requestCompletion();
    await store.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: 'verifier-before-pause',
      evidenceSha256: '2'.repeat(64),
    });

    await expect(store.pause()).resolves.toMatchObject({ status: 'paused' });
    await expect(store.resume()).resolves.toMatchObject({
      status: 'verifying',
      completionVerification: {
        status: 'pass',
      },
    });
    await expect(GoalStore.hasActiveGoal(workspaceRoot, sessionId)).resolves.toBe(true);
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
    await expect(store.edit('revised objective')).resolves.toMatchObject({
      objective: 'revised objective',
      status: 'paused',
      statusReason: 'paused by user',
    });
    await expect(store.resume()).resolves.toMatchObject({ status: 'active' });
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
