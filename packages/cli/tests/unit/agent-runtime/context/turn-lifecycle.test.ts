import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectTurnLifecycle } from '../../../../src/context/events/turnLifecycle.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';

describe('durable turn lifecycle', () => {
  let storageRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-turn-lifecycle-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('persists one idempotent start and completion boundary', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-1', {
      turnId: 'turn-1',
      kind: 'user',
      startedAt: '2026-08-11T10:00:00.000Z',
      inputMessageIds: ['input-1'],
    });
    await store.saveTurnStart('session-1', {
      turnId: 'turn-1',
      kind: 'user',
      startedAt: '2026-08-11T10:00:00.000Z',
      inputMessageIds: ['input-1'],
    });
    await store.saveTurnCompletion('session-1', {
      turnId: 'turn-1',
      completedAt: '2026-08-11T10:00:01.000Z',
      turnsCount: 2,
      toolCallsCount: 1,
      durationMs: 1000,
    });
    await store.saveTurnCompletion('session-1', {
      turnId: 'turn-1',
      completedAt: '2026-08-11T10:00:01.000Z',
      turnsCount: 2,
      toolCallsCount: 1,
      durationMs: 1000,
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-1')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    expect(projectTurnLifecycle(events)).toMatchObject({
      active: null,
      lastTerminal: {
        type: 'turn_completed',
        data: {
          turnId: 'turn-1',
          turnsCount: 2,
          toolCallsCount: 1,
          durationMs: 1000,
        },
      },
    });
  });

  it('closes an orphaned turn exactly once after runtime restart', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-2', {
      turnId: 'turn-orphan',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      inputMessageIds: ['pending-1'],
    });

    await expect(store.recoverInterruptedTurn('session-2')).resolves.toBe(
      'turn-orphan'
    );
    await expect(store.recoverInterruptedTurn('session-2')).resolves.toBeUndefined();

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-2')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          turnId: 'turn-orphan',
          cause: 'process_restart',
        }),
      }),
    ]);
    expect(projectTurnLifecycle(events).active).toBeNull();
  });

  it('rejects a second active turn before the first reaches a terminal state', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-3', {
      turnId: 'turn-1',
      kind: 'user',
      startedAt: new Date().toISOString(),
    });

    await expect(
      store.saveTurnStart('session-3', {
        turnId: 'turn-2',
        kind: 'goal',
        startedAt: new Date().toISOString(),
      })
    ).rejects.toThrow('Session already has an active turn: turn-1');
  });
});
