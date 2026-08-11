import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectTurnLifecycle } from '../../../../src/context/events/turnLifecycle.js';
import { findPendingSessionInteraction } from '../../../../src/context/interactions.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import {
  PersistentStore,
  PROCESS_RESTART_TOOL_RESULT,
} from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../../src/services/SessionService.js';

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

  it('closes orphaned tool calls before aborting the interrupted turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-tool-crash', {
      turnId: 'turn-tool-crash',
      kind: 'user',
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const toolCallId = await store.saveToolUse(
      'session-tool-crash',
      'Write',
      { file_path: '/workspace/result.txt', content: 'done' },
      null
    );

    await expect(store.recoverInterruptedTurn('session-tool-crash')).resolves.toBe(
      'turn-tool-crash'
    );
    await expect(
      store.recoverInterruptedTurn('session-tool-crash')
    ).resolves.toBeUndefined();

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-tool-crash')
    ).readAll();
    const receiptIndex = events.findIndex(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.partId === toolCallId
    );
    const abortIndex = events.findIndex((event) => event.type === 'turn_aborted');
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(abortIndex).toBeGreaterThan(receiptIndex);
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            error: PROCESS_RESTART_TOOL_RESULT,
            metadata: {
              processRestartRecovery: true,
              sideEffectsUncertain: true,
            },
          }),
        }),
      }),
    ]);
    expect(events[abortIndex]).toMatchObject({
      data: { toolCallsCount: 1 },
    });

    const modelContext = SessionService.convertJSONLToModelContext(events);
    expect(modelContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [
            expect.objectContaining({
              id: toolCallId,
              function: expect.objectContaining({ name: 'Write' }),
            }),
          ],
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: toolCallId,
          content: `Error: ${PROCESS_RESTART_TOOL_RESULT}`,
        }),
      ])
    );
  });

  it('repairs every terminal turn orphan without appending another turn terminal', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-terminal-orphan', {
      turnId: 'turn-terminal-orphan',
      kind: 'user',
      startedAt: new Date().toISOString(),
    });
    const firstToolCallId = await store.saveToolUse(
      'session-terminal-orphan',
      'Bash',
      { command: 'external-side-effect' },
      null
    );
    const secondToolCallId = await store.saveToolUse(
      'session-terminal-orphan',
      'Write',
      { file_path: '/workspace/concurrent.txt', content: 'done' },
      null
    );
    await store.saveTurnAbort('session-terminal-orphan', {
      turnId: 'turn-terminal-orphan',
      cause: 'failed',
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 1,
      durationMs: 1,
    });

    await expect(
      store.recoverInterruptedTurn('session-terminal-orphan')
    ).resolves.toBeUndefined();
    await expect(
      store.recoverInterruptedTurn('session-terminal-orphan')
    ).resolves.toBeUndefined();

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-terminal-orphan')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    for (const toolCallId of [firstToolCallId, secondToolCallId]) {
      expect(
        events.filter(
          (event) =>
            event.type === 'part_created' &&
            event.data.partType === 'tool_result' &&
            event.data.partId === toolCallId
        )
      ).toHaveLength(1);
    }
  });

  it('leaves pending durable interactions to their dedicated recovery flow', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-interaction-crash', {
      turnId: 'turn-interaction-crash',
      kind: 'user',
      startedAt: new Date().toISOString(),
    });
    const toolCallId = await store.saveToolUse(
      'session-interaction-crash',
      'AskUserQuestion',
      { question: 'Continue?' },
      null
    );
    await store.saveInteractionRequest('session-interaction-crash', {
      requestId: 'request-crash',
      toolCallId,
      toolName: 'AskUserQuestion',
      interactionType: 'question',
      details: { question: 'Continue?' },
      requestedAt: new Date().toISOString(),
    });

    await store.recoverInterruptedTurn('session-interaction-crash');
    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-interaction-crash')
    ).readAll();
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toEqual([]);
    expect(findPendingSessionInteraction(events)?.request.requestId).toBe(
      'request-crash'
    );
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
