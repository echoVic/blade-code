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

  it('rejects empty and overlong host turn identifiers', async () => {
    const store = new GoalStore(workspaceRoot, sessionId);

    await expect(
      store.create({ objective: 'reject invalid root' }, { turnId: '' })
    ).rejects.toThrow('Goal turn ID');
    await store.create({ objective: 'reject invalid continuation' });
    await expect(store.prepareTurnBinding('x'.repeat(129), true)).rejects.toThrow(
      'Goal turn ID'
    );
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
});
