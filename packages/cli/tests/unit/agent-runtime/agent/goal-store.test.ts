import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { getSessionGoalFilePath } from '../../../../src/context/storage/pathUtils.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';
import type { SessionGoalFinalizationInfo } from '../../../../src/context/types.js';
import { GoalStore } from '../../../../src/goals/GoalStore.js';
import type {
  GoalExecutionFrontier,
  GoalFrontierStallState,
} from '../../../../src/goals/types.js';

describe('GoalStore', () => {
  let storageRoot: string;
  let workspaceRoot: string;
  const sessionId = 'goal-session';

  const frontier: GoalExecutionFrontier = {
    taskListId: 'goal:goal-session:goal-1',
    total: 2,
    completed: 1,
    inProgress: 0,
    pending: 1,
    blocked: 0,
    nextTask: {
      id: '2',
      subject: 'Run the focused test',
      priority: 'high',
    },
    digestSha256: 'a'.repeat(64),
    observedAt: '2026-08-28T00:00:00.000Z',
  };

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-goal-store-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    expect(GoalStore.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
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

  it('stores remote goals directly under an explicitly authorized state root', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const store = new GoalStore(hostStateRoot, sessionId, remoteStorage);
    const created = await store.create({ objective: 'keep state on the host' });

    const goalPath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => path.join(String(scope), `${sessionId}.goal.json`)
    );
    expect(JSON.parse(await readFile(goalPath, 'utf8'))).toEqual(created);
    await expect(
      GoalStore.hasActiveGoal(hostStateRoot, sessionId, remoteStorage)
    ).resolves.toBe(true);
    await expect(
      SessionRuntime.hasActiveGoal(hostStateRoot, sessionId, remoteStorage)
    ).resolves.toBe(true);
    await expect(
      new GoalStore(hostStateRoot, sessionId, remoteStorage).get()
    ).resolves.toEqual(created);
    await expect(store.clear()).resolves.toBe(true);
    await expect(stat(goalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(getSessionGoalFilePath(hostStateRoot, sessionId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates the remote state scope before every goal I/O', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const store = new GoalStore(hostStateRoot, sessionId, remoteStorage);
    await store.create({ objective: 'guard every access' });

    await chmod(hostStateRoot, 0o755);
    await expect(store.get()).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    await expect(store.edit('blocked write')).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    await expect(store.clear()).rejects.toMatchObject({
      code: 'acp_remote_workspace_state_invalid',
    });
    await chmod(hostStateRoot, 0o700);
  });

  it('creates version 2 goals and persists the execution frontier atomically', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'ship the frontier' });

    expect((created as { version: number }).version).toBe(2);

    const updated = await store.recordExecutionFrontier({
      ...frontier,
      taskListId: `goal:${sessionId}:${created.goalId}`,
    });

    expect(updated).toMatchObject({
      version: 2,
      executionFrontier: {
        total: 2,
        completed: 1,
        pending: 1,
        nextTask: { subject: 'Run the focused test' },
      },
    });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toEqual(
      updated
    );
  });

  it('persists a bounded frontier stall observation with the frontier', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'persist stall' });
    const stall: GoalFrontierStallState = {
      category: 'same_task_no_effect',
      consecutiveCount: 2,
      digestSha256: frontier.digestSha256,
      detectedAt: '2026-08-28T00:00:00.000Z',
    };

    const scopedFrontier = {
      ...frontier,
      taskListId: `goal:${sessionId}:${created.goalId}`,
    };
    const updated = await store.recordExecutionFrontier(scopedFrontier, {
      ...stall,
      digestSha256: scopedFrontier.digestSha256,
    });

    expect(updated.version).toBe(2);
    expect(updated.executionFrontier).toEqual(scopedFrontier);
    expect(updated.frontierStall).toEqual({
      ...stall,
      digestSha256: scopedFrontier.digestSha256,
    });
    expect((await store.get())?.frontierStall).toEqual({
      ...stall,
      digestSha256: scopedFrontier.digestSha256,
    });
    expect(created.goalId).toBe(updated.goalId);
  });

  it('clears a previous frontier stall when a fresh frontier has no observation', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'clear stall' });
    const scopedFrontier = {
      ...frontier,
      taskListId: `goal:${sessionId}:${created.goalId}`,
    };
    const stall: GoalFrontierStallState = {
      category: 'repeated_deferral',
      consecutiveCount: 1,
      digestSha256: scopedFrontier.digestSha256,
      detectedAt: '2026-08-28T00:00:00.000Z',
    };
    await store.recordExecutionFrontier(scopedFrontier, stall);

    const updated = await store.recordExecutionFrontier({
      ...scopedFrontier,
      digestSha256: 'b'.repeat(64),
    });

    expect(updated).not.toHaveProperty('frontierStall');
  });

  it('clears frontier stall state after a durable workspace mutation', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'clear after mutation' });
    const scopedFrontier = {
      ...frontier,
      taskListId: `goal:${sessionId}:${created.goalId}`,
    };
    const stall: GoalFrontierStallState = {
      category: 'same_task_no_effect',
      consecutiveCount: 2,
      digestSha256: scopedFrontier.digestSha256,
      detectedAt: '2026-08-28T00:00:00.000Z',
    };
    await store.recordExecutionFrontier(scopedFrontier, stall);

    const updated = await store.clearFrontierStall();

    expect(updated).not.toHaveProperty('frontierStall');
  });

  it('treats clearing frontier stall without a Goal as an atomic no-op', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);

    await expect(store.clearFrontierStall()).resolves.toBeNull();
    await expect(store.get()).resolves.toBeNull();
  });

  it('reads a version 1 goal and upgrades it when the frontier is recorded', async () => {
    const filePath = getSessionGoalFilePath(workspaceRoot, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const legacyGoal = {
      version: 1,
      sessionId,
      goalId: 'goal-1',
      objective: 'upgrade the persisted goal',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 0,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    await writeFile(filePath, JSON.stringify(legacyGoal), { mode: 0o600 });

    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toMatchObject({
      version: 1,
      goalId: 'goal-1',
    });
    const upgraded = await new GoalStore(
      workspaceRoot,
      sessionId
    ).recordExecutionFrontier({
      ...frontier,
      taskListId: 'goal:goal-session:goal-1',
    });

    expect(upgraded).toMatchObject({ version: 2, executionFrontier: frontier });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      version: 2,
      executionFrontier: frontier,
    });
  });

  it('rejects an execution frontier for a different goal', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    const created = await store.create({ objective: 'reject a mismatched frontier' });

    await expect(
      store.recordExecutionFrontier({ ...frontier, taskListId: 'goal:other:goal' })
    ).rejects.toThrow('does not match the current goal');
    const unchanged = await store.get();
    expect(unchanged).toMatchObject({ goalId: created.goalId });
    expect(unchanged).not.toHaveProperty('executionFrontier');
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
        verifierSessionId: 'verifier-invalid-feedback',
        evidenceSha256: 'a'.repeat(64),
        feedbackSha256: 'not-a-digest',
      })
    ).rejects.toThrow('feedback requires a SHA-256 digest');

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

  it('persists verifier feedback and blocks an identical gap after three attempts', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'converge on the same missing requirement' });
    const feedbackSha256 = 'a'.repeat(64);

    for (let attempt = 1; attempt <= 2; attempt++) {
      await store.requestCompletion();
      await expect(
        store.recordCompletionVerification({
          verdict: attempt === 1 ? 'fail' : 'partial',
          verifierSessionId: `verifier-${attempt}`,
          summary: 'Missing the required restart regression test.',
          evidenceSha256: String(attempt).repeat(64),
          feedbackSha256,
        })
      ).resolves.toMatchObject({
        status: 'verifying',
        completionVerification: {
          attempt,
          summary: 'Missing the required restart regression test.',
        },
        verificationStall: {
          feedbackSha256,
          consecutiveCount: attempt,
        },
      });
    }

    const pending = await store.requestCompletion();
    expect(pending).toMatchObject({
      completionVerification: {
        attempt: 3,
        status: 'pending',
        summary: 'Missing the required restart regression test.',
      },
      verificationStall: { consecutiveCount: 2 },
    });
    await expect(
      store.recordCompletionVerification({
        verdict: 'fail',
        verifierSessionId: 'verifier-3',
        summary: 'Missing the required restart regression test.',
        evidenceSha256: '3'.repeat(64),
        feedbackSha256,
      })
    ).resolves.toMatchObject({
      status: 'blocked',
      statusReason:
        'automatic verification convergence guard after 3 identical gap reports',
      completionVerification: {
        attempt: 3,
        status: 'fail',
        summary: 'Missing the required restart regression test.',
      },
      verificationStall: {
        feedbackSha256,
        consecutiveCount: 3,
      },
    });
    await expect(store.tryBeginContinuation()).resolves.toBeNull();
    await expect(store.resume()).resolves.toMatchObject({
      status: 'active',
      verificationStall: undefined,
    });
  });

  it('resets verifier convergence when the reported gap changes', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'resolve changing verification gaps' });
    await store.requestCompletion();
    await store.recordCompletionVerification({
      verdict: 'fail',
      verifierSessionId: 'verifier-1',
      summary: 'First gap.',
      evidenceSha256: '1'.repeat(64),
      feedbackSha256: 'a'.repeat(64),
    });
    await store.requestCompletion();

    await expect(
      store.recordCompletionVerification({
        verdict: 'fail',
        verifierSessionId: 'verifier-2',
        summary: 'Second gap.',
        evidenceSha256: '2'.repeat(64),
        feedbackSha256: 'b'.repeat(64),
      })
    ).resolves.toMatchObject({
      status: 'verifying',
      verificationStall: {
        feedbackSha256: 'b'.repeat(64),
        consecutiveCount: 1,
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

  it('persists consecutive premature stops and clears the streak on progress', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'keep making progress' });

    await expect(
      store.recordProgress({
        tokens: 10,
        elapsedMs: 1_000,
        prematureStopPattern: 'self_deferral',
      })
    ).resolves.toMatchObject({
      prematureStop: {
        pattern: 'self_deferral',
        consecutiveCount: 1,
      },
    });
    await expect(
      store.recordProgress({
        tokens: 10,
        elapsedMs: 1_000,
        prematureStopPattern: 'self_deferral',
      })
    ).resolves.toMatchObject({
      prematureStop: {
        pattern: 'self_deferral',
        consecutiveCount: 2,
      },
    });
    await expect(new GoalStore(workspaceRoot, sessionId).get()).resolves.toMatchObject({
      prematureStop: {
        pattern: 'self_deferral',
        consecutiveCount: 2,
        detectedAt: expect.any(String),
      },
    });

    await expect(
      store.recordProgress({
        tokens: 10,
        elapsedMs: 1_000,
        prematureStopPattern: 'internal_wait',
      })
    ).resolves.toMatchObject({
      prematureStop: {
        pattern: 'internal_wait',
        consecutiveCount: 1,
      },
    });
    await expect(
      store.recordProgress({ tokens: 10, elapsedMs: 1_000 })
    ).resolves.toMatchObject({ prematureStop: undefined });
  });

  it('clears stale premature-stop recovery after explicit user resume', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'resume with fresh evidence' });
    await store.recordProgress({
      tokens: 10,
      elapsedMs: 1_000,
      prematureStopPattern: 'stopping_here',
    });
    await store.pause();

    await expect(store.resume()).resolves.toMatchObject({
      status: 'active',
      prematureStop: undefined,
    });
  });

  it('blocks a goal after the same premature-stop pattern repeats three times', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);
    await store.create({ objective: 'stop an unproductive loop' });

    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(
        store.recordProgress({
          tokens: 10,
          elapsedMs: 1_000,
          prematureStopPattern: 'internal_wait',
        })
      ).resolves.toMatchObject({
        status: 'active',
        prematureStop: { consecutiveCount: attempt },
      });
    }
    await expect(
      store.recordProgress({
        tokens: 10,
        elapsedMs: 1_000,
        prematureStopPattern: 'internal_wait',
      })
    ).resolves.toMatchObject({
      status: 'blocked',
      statusReason: 'automatic liveness guard after 3 consecutive internal_wait turns',
      completionVerification: undefined,
      prematureStop: {
        pattern: 'internal_wait',
        consecutiveCount: 3,
      },
    });
    await expect(store.tryBeginContinuation()).resolves.toBeNull();
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

  it('does not retain historical Goal keys after high-cardinality reads', async () => {
    await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        new GoalStore(workspaceRoot, `historical-${index}`).get()
      )
    );

    expect(GoalStore.coordinationStatsForTests()).toEqual({
      keys: 0,
      operations: 0,
    });
  });
});
