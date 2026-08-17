import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalTools } from '../../../../../src/tools/builtin/goal/index.js';

describe('goal tools', () => {
  let storageRoot: string;
  const sessionId = 'goal-tool-session';
  const workspaceRoot = '/tmp/goal-tool-workspace';

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-goal-tools-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const tool = createGoalTools({ sessionId, workspaceRoot }).find(
      (candidate) => candidate.name === name
    );
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool as any;
  }

  function execute(name: string, params: Record<string, unknown>) {
    return getTool(name)
      .build(params)
      .execute(new AbortController().signal, undefined, {
        sessionId,
        workspaceRoot,
      });
  }

  it('creates, reads, and submits a host-verified completion candidate', async () => {
    const created = await execute('CreateGoal', {
      objective: 'finish the migration',
      tokenBudget: 500,
    });
    expect(created).toMatchObject({
      success: true,
      llmContent: {
        goal: {
          objective: 'finish the migration',
          status: 'active',
          tokenBudget: 500,
        },
      },
    });

    await expect(execute('GetGoal', {})).resolves.toMatchObject({
      success: true,
      llmContent: {
        goal: {
          objective: 'finish the migration',
          status: 'active',
        },
      },
    });

    await expect(execute('UpdateGoal', { status: 'complete' })).resolves.toMatchObject({
      success: true,
      llmContent: {
        goal: {
          status: 'verifying',
          completionVerification: {
            attempt: 1,
            status: 'pending',
          },
        },
      },
      metadata: {
        goalCompletionRequested: true,
        goalObjective: 'finish the migration',
        goalCompletionAttempt: 1,
        goalCompletionRequestedAt: expect.any(String),
      },
    });
  });

  it('requires a concrete reason when the model marks a goal blocked', async () => {
    await execute('CreateGoal', { objective: 'finish the migration' });

    await expect(execute('UpdateGoal', { status: 'blocked' })).resolves.toMatchObject({
      success: false,
      error: { code: 'GOAL_OPERATION_FAILED' },
    });
    await expect(
      execute('UpdateGoal', {
        status: 'blocked',
        reason: 'external credential is unavailable',
      })
    ).resolves.toMatchObject({
      success: true,
      llmContent: { goal: { status: 'blocked' } },
      metadata: { goalStatus: 'blocked' },
    });
  });
});
