import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentSession,
  AgentSessionStore,
} from '../../src/agent/subagents/AgentSessionStore.js';
import {
  BackgroundAgentManager,
  PROCESS_RESTART_SUBAGENT_ERROR,
  PROCESS_RESTART_SUBAGENT_RECOVERY_FAILED,
} from '../../src/agent/subagents/BackgroundAgentManager.js';
import { subagentWorktreeLifecycle } from '../../src/agent/subagents/SubagentWorktreeLifecycle.js';
import { projectTurnLifecycle } from '../../src/context/events/turnLifecycle.js';
import { ForegroundProcessLeaseStore } from '../../src/context/storage/ForegroundProcessLeaseStore.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../src/context/storage/pathUtils.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';

const execFileAsync = promisify(execFile);

vi.unmock('child_process');
vi.unmock('node:child_process');

describe('durable subagent crash recovery', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  const owner = {
    sessionId: 'parent-crash-recovery',
    projectPath: '',
  };

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-subagent-crash-'));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    owner.projectPath = workspace;
    resetSingletons();
  });

  afterEach(async () => {
    BackgroundAgentManager.getInstance().killAll();
    resetSingletons();
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await rm(root, { recursive: true, force: true });
  });

  function resetSingletons(): void {
    (
      BackgroundAgentManager as unknown as {
        instance: BackgroundAgentManager | null;
      }
    ).instance = null;
    (
      AgentSessionStore as unknown as {
        instance: AgentSessionStore | null;
      }
    ).instance = null;
  }

  function saveRunningSidecar(
    id: string,
    messages: AgentSession['messages'] = [],
    overrides: Partial<AgentSession> = {}
  ): void {
    const now = Date.now() - 1_000;
    AgentSessionStore.getInstance().saveSession({
      schemaVersion: 2,
      id,
      subagentType: 'Explore',
      description: 'Recover durable child progress',
      prompt: 'Inspect the project.',
      messages,
      status: 'running',
      createdAt: now,
      lastActiveAt: now,
      processId: process.pid,
      processIdentity: {
        platform: process.platform,
        fingerprint: '0'.repeat(64),
      },
      parentSessionId: owner.sessionId,
      parentProjectPath: workspace,
      rootAgentId: id,
      resumeDepth: 0,
      configSnapshot: {
        name: 'Explore',
        description: 'Explore',
        tools: ['Read'],
      },
      workspaceRoot: workspace,
      isolation: 'none',
      ...overrides,
    });
  }

  async function git(...args: string[]): Promise<void> {
    await execFileAsync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
    });
  }

  it('closes an active child turn and merges committed JSONL history', async () => {
    const agentId = 'agent-crash-active';
    saveRunningSidecar(agentId, [
      { role: 'user', content: 'Source context' },
      { role: 'assistant', content: 'Source answer' },
    ]);
    const persistent = new PersistentStore(workspace);
    await persistent.initialize();
    await persistent.saveTurnStart(agentId, {
      turnId: 'turn-crash-active',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    await persistent.saveMessage(agentId, 'user', 'New durable request');
    await persistent.saveMessage(
      agentId,
      'assistant',
      'Committed progress before restart'
    );

    const manager = BackgroundAgentManager.getInstance();
    await manager.reconcileOrphanedSessions(owner);

    const recovered = AgentSessionStore.getInstance().loadSession(agentId);
    expect(recovered).toMatchObject({
      status: 'failed',
      processId: undefined,
      processIdentity: undefined,
      restartRecovery: { outcome: 'interrupted' },
      result: {
        success: false,
        error: PROCESS_RESTART_SUBAGENT_ERROR,
      },
    });
    expect(recovered?.messages.map((message) => message.content)).toEqual([
      'Source context',
      'Source answer',
      'New durable request',
      'Committed progress before restart',
    ]);
    const events = await persistent.loadEvents(agentId);
    expect(projectTurnLifecycle(events ?? []).lastTerminal).toMatchObject({
      type: 'turn_aborted',
      data: {
        turnId: 'turn-crash-active',
        cause: 'process_restart',
      },
    });
  });

  it('reaps child foreground and background processes before transcript recovery', async () => {
    const agentId = 'agent-crash-process-order';
    saveRunningSidecar(agentId);
    const persistent = new PersistentStore(workspace);
    await persistent.initialize();
    await persistent.saveTurnStart(agentId, {
      turnId: 'turn-crash-process-order',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    const order: string[] = [];
    const foreground = vi
      .spyOn(ForegroundProcessLeaseStore.prototype, 'reapOrphans')
      .mockImplementationOnce(async () => {
        order.push('foreground');
        return { reaped: 0, stale: 0, active: 0, protected: 0 };
      });
    const background = vi
      .spyOn(BackgroundShellManager.prototype, 'reapOrphanedSession')
      .mockImplementationOnce(async () => {
        order.push('background');
        return { reaped: 0, stale: 0, active: 0, protected: 0 };
      });
    const originalRecover = PersistentStore.prototype.recoverInterruptedTurn;
    const recover = vi
      .spyOn(PersistentStore.prototype, 'recoverInterruptedTurn')
      .mockImplementationOnce(async function (...args) {
        order.push('transcript');
        return await originalRecover.apply(this, args);
      });

    try {
      await BackgroundAgentManager.getInstance().reconcileOrphanedSessions(owner);
      expect(order).toEqual(['foreground', 'background', 'transcript']);
    } finally {
      foreground.mockRestore();
      background.mockRestore();
      recover.mockRestore();
    }
  });

  it('recovers a final-ready child as completed exactly once', async () => {
    const agentId = 'agent-crash-final-ready';
    saveRunningSidecar(agentId);
    const persistent = new PersistentStore(workspace);
    await persistent.initialize();
    await persistent.saveTurnStart(agentId, {
      turnId: 'turn-crash-final-ready',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    await persistent.saveMessage(agentId, 'user', 'Finish before restart');
    await persistent.saveMessage(
      agentId,
      'assistant',
      'FINAL_READY_CHILD_RESULT',
      null,
      {
        turnFinalization: {
          turnId: 'turn-crash-final-ready',
          inputMessageIds: [],
          turnsCount: 2,
          toolCallsCount: 1,
          durationMs: 400,
        },
      }
    );

    const manager = BackgroundAgentManager.getInstance();
    await manager.reconcileOrphanedSessions(owner);
    const sidecarPath = path.join(
      process.env.BLADE_STORAGE_ROOT!,
      'agents',
      'sessions',
      `${agentId}.json`
    );
    const firstBytes = await readFile(sidecarPath, 'utf8');
    await manager.reconcileOrphanedSessions(owner);

    expect(await readFile(sidecarPath, 'utf8')).toBe(firstBytes);
    expect(AgentSessionStore.getInstance().loadSession(agentId)).toMatchObject({
      status: 'completed',
      restartRecovery: { outcome: 'completed' },
      result: {
        success: true,
        message: 'FINAL_READY_CHILD_RESULT',
      },
      stats: {
        toolCalls: 1,
        duration: 400,
      },
    });
    const lifecycle = projectTurnLifecycle(
      (await persistent.loadEvents(agentId)) ?? []
    );
    expect(lifecycle.active).toBeNull();
    expect(lifecycle.lastTerminal?.type).toBe('turn_completed');
  });

  it('does not reuse an inherited assistant as the recovered final result', async () => {
    const agentId = 'agent-crash-empty-final';
    saveRunningSidecar(agentId, [
      { role: 'assistant', content: 'INHERITED_RESULT_MUST_NOT_WIN' },
    ]);
    const persistent = new PersistentStore(workspace);
    await persistent.initialize();
    await persistent.saveTurnStart(agentId, {
      turnId: 'turn-crash-empty-final',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    await persistent.saveMessage(agentId, 'user', 'Return structured output only');
    await persistent.saveMessage(agentId, 'assistant', '', null, {
      turnFinalization: {
        turnId: 'turn-crash-empty-final',
        inputMessageIds: [],
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 100,
      },
    });

    const manager = BackgroundAgentManager.getInstance();
    await manager.reconcileOrphanedSessions(owner);

    expect(AgentSessionStore.getInstance().loadSession(agentId)).toMatchObject({
      status: 'failed',
      restartRecovery: { outcome: 'interrupted' },
      result: {
        success: false,
        message: '',
        error: PROCESS_RESTART_SUBAGENT_ERROR,
      },
    });
  });

  it('keeps interrupted changes and removes a completed clean worktree', async () => {
    await writeFile(path.join(workspace, 'value.txt'), 'parent\n');
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'blade-test@example.com');
    await git('config', 'user.name', 'Blade Test');
    await git('add', '.');
    await git('commit', '-m', 'initial');

    const interruptedId = 'agent-crash-worktree-interrupted';
    const interruptedLease = await subagentWorktreeLifecycle.prepare({
      agentId: interruptedId,
      sourceWorkspaceRoot: workspace,
      isolation: 'worktree',
    });
    await writeFile(
      path.join(interruptedLease.workspaceRoot, 'value.txt'),
      'interrupted change\n'
    );
    saveRunningSidecar(interruptedId, [], {
      isolation: 'worktree',
      worktree: interruptedLease.worktree,
    });
    const interruptedStore = new PersistentStore(interruptedLease.workspaceRoot);
    await interruptedStore.initialize();
    await interruptedStore.saveTurnStart(interruptedId, {
      turnId: 'turn-worktree-interrupted',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    await interruptedStore.saveMessage(
      interruptedId,
      'user',
      'Preserve my partial changes'
    );

    const completedId = 'agent-crash-worktree-completed';
    const completedLease = await subagentWorktreeLifecycle.prepare({
      agentId: completedId,
      sourceWorkspaceRoot: workspace,
      isolation: 'worktree',
    });
    saveRunningSidecar(completedId, [], {
      isolation: 'worktree',
      worktree: completedLease.worktree,
    });
    const completedStore = new PersistentStore(completedLease.workspaceRoot);
    await completedStore.initialize();
    await completedStore.saveTurnStart(completedId, {
      turnId: 'turn-worktree-completed',
      kind: 'user',
      startedAt: new Date(Date.now() - 500).toISOString(),
    });
    await completedStore.saveMessage(completedId, 'user', 'Finish cleanly');
    await completedStore.saveMessage(
      completedId,
      'assistant',
      'CLEAN_WORKTREE_COMPLETE',
      null,
      {
        turnFinalization: {
          turnId: 'turn-worktree-completed',
          inputMessageIds: [],
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 100,
        },
      }
    );

    const manager = BackgroundAgentManager.getInstance();
    await manager.reconcileOrphanedSessions(owner);

    expect(AgentSessionStore.getInstance().loadSession(interruptedId)).toMatchObject({
      status: 'failed',
      restartRecovery: { outcome: 'interrupted' },
      worktree: {
        worktreeRoot: interruptedLease.worktree?.worktreeRoot,
      },
    });
    expect(
      await readFile(path.join(interruptedLease.workspaceRoot, 'value.txt'), 'utf8')
    ).toBe('interrupted change\n');
    expect(AgentSessionStore.getInstance().loadSession(completedId)).toMatchObject({
      status: 'completed',
      restartRecovery: { outcome: 'completed' },
      worktree: undefined,
    });
    await expect(access(completedLease.workspaceRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed and disables resume for a corrupt child transcript', async () => {
    const agentId = 'agent-crash-corrupt';
    saveRunningSidecar(agentId);
    await mkdir(path.dirname(getSessionFilePath(workspace, agentId)), {
      recursive: true,
    });
    await writeFile(
      getSessionFilePath(workspace, agentId),
      '{"type":"broken"}\n',
      'utf8'
    );

    const manager = BackgroundAgentManager.getInstance();
    await manager.reconcileOrphanedSessions(owner);

    const recovered = AgentSessionStore.getInstance().loadSession(agentId);
    expect(recovered).toMatchObject({
      status: 'failed',
      restartRecovery: { outcome: 'failed' },
      result: {
        success: false,
        error: PROCESS_RESTART_SUBAGENT_RECOVERY_FAILED,
      },
    });
    expect(
      manager.resumeAgent({
        agentId,
        prompt: 'Continue unsafely',
        config: { name: 'Explore', description: 'Explore' },
        owner,
      })
    ).toBeUndefined();
  });
});
