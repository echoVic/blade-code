import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import goalCommand from '../../../../src/slash-commands/goal.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

describe('/goal', () => {
  let storageRoot: string;
  const context: SlashCommandContext = {
    cwd: '/tmp/goal-workspace',
    workspaceRoot: '/tmp/goal-workspace',
    sessionId: 'goal-command-session',
  };

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-goal-command-'));
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('creates a persisted goal and requests an agent continuation', async () => {
    const result = await goalCommand.handler(
      ['finish', 'the', 'migration', '--budget', '1200'],
      context
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'start_goal',
        goal: {
          objective: 'finish the migration',
          tokenBudget: 1200,
          status: 'active',
        },
      },
    });
  });

  it('supports status, pause, resume, edit, and clear', async () => {
    await goalCommand.handler(['initial', 'objective'], context);

    await expect(goalCommand.handler(['status'], context)).resolves.toMatchObject({
      success: true,
      data: { goal: { objective: 'initial objective', status: 'active' } },
    });
    await expect(goalCommand.handler(['pause'], context)).resolves.toMatchObject({
      success: true,
      data: { goal: { status: 'paused' } },
    });
    await expect(goalCommand.handler(['resume'], context)).resolves.toMatchObject({
      success: true,
      data: { action: 'resume_goal', goal: { status: 'active' } },
    });
    await expect(
      goalCommand.handler(['edit', 'revised', 'objective'], context)
    ).resolves.toMatchObject({
      success: true,
      data: {
        action: 'resume_goal',
        goal: { objective: 'revised objective', status: 'active' },
      },
    });
    await expect(goalCommand.handler(['clear'], context)).resolves.toMatchObject({
      success: true,
      data: { action: 'goal_cleared', goal: null },
    });
  });

  it('rejects invalid budgets without creating a goal', async () => {
    const result = await goalCommand.handler(
      ['objective', '--budget', 'not-a-number'],
      context
    );
    expect(result).toMatchObject({
      success: false,
      error: '--budget requires a positive integer',
    });
    await expect(goalCommand.handler(['status'], context)).resolves.toMatchObject({
      success: true,
      content: 'No goal is configured for this session.',
    });
  });
});
