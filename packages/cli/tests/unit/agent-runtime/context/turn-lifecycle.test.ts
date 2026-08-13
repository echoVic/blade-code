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
    await store.saveTurnCompletion(
      'session-1',
      {
        turnId: 'turn-1',
        completedAt: '2026-08-11T10:00:01.000Z',
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 1000,
      },
      ['input-1']
    );
    await store.saveTurnCompletion(
      'session-1',
      {
        turnId: 'turn-1',
        completedAt: '2026-08-11T10:00:01.000Z',
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 1000,
      },
      ['input-1']
    );

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-1')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    const acknowledgement = events.find((event) => event.type === 'inbox_acknowledged');
    const completion = events.find((event) => event.type === 'turn_completed');
    expect(acknowledgement).toMatchObject({
      data: { messageIds: ['input-1'] },
    });
    expect(completion?.seq).toBe((acknowledgement?.seq ?? 0) + 1);
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

    await expect(store.recoverInterruptedTurn('session-2')).resolves.toEqual({
      turnId: 'turn-orphan',
      outcome: 'aborted',
    });
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

    await expect(store.recoverInterruptedTurn('session-tool-crash')).resolves.toEqual({
      turnId: 'turn-tool-crash',
      outcome: 'aborted',
    });
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

  it('atomically adopts a host-validated subagent result before aborting the parent turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-task-adoption', {
      turnId: 'turn-task-adoption',
      kind: 'user',
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const assistantMessageId = await store.saveMessage(
      'session-task-adoption',
      'assistant',
      ''
    );
    const toolCallId = await store.saveToolUse(
      'session-task-adoption',
      'Task',
      {
        description: 'Inspect the durable marker',
        prompt: 'Find the durable marker and report it.',
        subagent_type: 'Explore',
        subagent_session_id: 'agent-adopted-child',
      },
      assistantMessageId
    );

    await expect(
      store.loadInterruptedToolCalls('session-task-adoption')
    ).resolves.toEqual([
      {
        toolCallId,
        messageId: assistantMessageId,
        toolName: 'Task',
        input: {
          description: 'Inspect the durable marker',
          prompt: 'Find the durable marker and report it.',
          subagent_type: 'Explore',
          subagent_session_id: 'agent-adopted-child',
        },
      },
    ]);
    await expect(
      store.recoverInterruptedTurn('session-task-adoption', {
        adoptedToolResults: new Map([
          [
            toolCallId,
            {
              toolCallId,
              toolName: 'Task',
              output: 'CHILD_DURABLE_MARKER\n\nAgent ID: agent-adopted-child',
              metadata: {
                processRestartRecovery: true,
                subagentResultAdopted: true,
                sideEffectsUncertain: false,
                subagentSessionId: 'agent-adopted-child',
                subagentType: 'Explore',
                subagentStatus: 'completed',
              },
              subagentRef: {
                subagentSessionId: 'agent-adopted-child',
                subagentType: 'Explore',
                subagentDescription: 'Inspect the durable marker',
                subagentStatus: 'completed',
                subagentSummary: 'CHILD_DURABLE_MARKER',
                subagentRootId: 'agent-adopted-child',
                subagentResumeDepth: 0,
              },
            },
          ],
        ]),
      })
    ).resolves.toEqual({
      turnId: 'turn-task-adoption',
      outcome: 'aborted',
    });
    await expect(
      store.recoverInterruptedTurn('session-task-adoption')
    ).resolves.toBeUndefined();

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-task-adoption')
    ).readAll();
    const resultEvents = events.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.partId === toolCallId
    );
    expect(resultEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          messageId: assistantMessageId,
          payload: expect.objectContaining({
            output: expect.stringContaining('CHILD_DURABLE_MARKER'),
            error: null,
            metadata: expect.objectContaining({
              processRestartRecovery: true,
              subagentResultAdopted: true,
              sideEffectsUncertain: false,
            }),
          }),
        }),
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'subtask_ref' &&
          event.data.messageId === assistantMessageId &&
          event.data.payload !== null &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.status === 'completed'
      )
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            childSessionId: 'agent-adopted-child',
            status: 'completed',
            summary: 'CHILD_DURABLE_MARKER',
          }),
        }),
      }),
    ]);
    const resultIndex = events.indexOf(resultEvents[0]!);
    const subtaskIndex = events.findIndex(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'subtask_ref' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.status === 'completed'
    );
    const abortIndex = events.findIndex((event) => event.type === 'turn_aborted');
    expect(subtaskIndex).toBeGreaterThan(resultIndex);
    expect(abortIndex).toBeGreaterThan(subtaskIndex);
    const modelContext = SessionService.convertJSONLToModelContext(events);
    expect(JSON.stringify(modelContext)).toContain('CHILD_DURABLE_MARKER');
    expect(
      modelContext.find(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((toolCall) => toolCall.id === toolCallId)
      )
    ).toMatchObject({
      metadata: {
        subtaskRef: {
          childSessionId: 'agent-adopted-child',
          status: 'completed',
          summary: 'CHILD_DURABLE_MARKER',
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain(PROCESS_RESTART_TOOL_RESULT);
  });

  it('completes and acknowledges a final-ready turn after runtime restart', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-final-ready', {
      turnId: 'turn-final-ready',
      kind: 'user',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      inputMessageIds: ['input-final', 'follow-up-not-claimed'],
    });
    await store.saveMessage(
      'session-final-ready',
      'user',
      'Finish exactly once.',
      null,
      { inboxMessageId: 'input-final' }
    );
    await store.saveMessage(
      'session-final-ready',
      'assistant',
      'Completed exactly once.',
      null,
      {
        turnFinalization: {
          turnId: 'turn-final-ready',
          inputMessageIds: ['input-final'],
          turnsCount: 2,
          toolCallsCount: 1,
          durationMs: 900,
          goalFinalization: {
            goalId: 'goal-final-ready',
            verificationAttempt: 2,
            verifierSessionId: 'verifier-final-ready',
            evidenceSha256: 'a'.repeat(64),
            goalUpdatedAt: '2026-08-11T10:00:00.000Z',
          },
        },
      }
    );

    await expect(
      store.recoverInterruptedTurn('session-final-ready')
    ).resolves.toMatchObject({
      turnId: 'turn-final-ready',
      outcome: 'completed',
      finalization: {
        goalFinalization: {
          goalId: 'goal-final-ready',
          verificationAttempt: 2,
          verifierSessionId: 'verifier-final-ready',
          evidenceSha256: 'a'.repeat(64),
        },
      },
    });
    await expect(
      store.recoverInterruptedTurn('session-final-ready')
    ).resolves.toBeUndefined();
    await expect(
      store.loadLatestGoalFinalization('session-final-ready')
    ).resolves.toEqual({
      turnId: 'turn-final-ready',
      finalization: {
        turnId: 'turn-final-ready',
        inputMessageIds: ['input-final'],
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 900,
        goalFinalization: {
          goalId: 'goal-final-ready',
          verificationAttempt: 2,
          verifierSessionId: 'verifier-final-ready',
          evidenceSha256: 'a'.repeat(64),
          goalUpdatedAt: '2026-08-11T10:00:00.000Z',
        },
      },
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-final-ready')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
    const acknowledgement = events.find((event) => event.type === 'inbox_acknowledged');
    const completion = events.find((event) => event.type === 'turn_completed');
    expect(acknowledgement).toMatchObject({
      data: { messageIds: ['input-final'] },
    });
    expect(completion).toMatchObject({
      data: {
        turnId: 'turn-final-ready',
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 900,
      },
    });
    expect(completion?.seq).toBe((acknowledgement?.seq ?? 0) + 1);
    expect(
      events.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes('follow-up-not-claimed')
      )
    ).toBe(false);
  });

  it('never acknowledges input when completion races an aborted terminal', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-abort-race', {
      turnId: 'turn-abort-race',
      kind: 'user',
      startedAt: new Date().toISOString(),
      inputMessageIds: ['input-retry'],
    });
    await store.saveTurnAbort('session-abort-race', {
      turnId: 'turn-abort-race',
      cause: 'failed',
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    });
    await store.saveTurnCompletion(
      'session-abort-race',
      {
        turnId: 'turn-abort-race',
        completedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      },
      ['input-retry']
    );

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-abort-race')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes('input-retry')
      )
    ).toBe(false);
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

  it('does not complete a final-ready turn with a malformed Goal receipt', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-invalid-goal-finalization', {
      turnId: 'turn-invalid-goal-finalization',
      kind: 'user',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      inputMessageIds: ['input-invalid-goal'],
    });
    await store.saveMessage(
      'session-invalid-goal-finalization',
      'assistant',
      'This must not become authoritative.',
      null,
      {
        turnFinalization: {
          turnId: 'turn-invalid-goal-finalization',
          inputMessageIds: ['input-invalid-goal'],
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 100,
          goalFinalization: {
            goalId: 'goal-invalid',
            verificationAttempt: 1,
            verifierSessionId: 'verifier-invalid',
            evidenceSha256: 'not-a-digest',
            goalUpdatedAt: new Date().toISOString(),
          },
        },
      }
    );

    await expect(
      store.recoverInterruptedTurn('session-invalid-goal-finalization')
    ).resolves.toEqual({
      turnId: 'turn-invalid-goal-finalization',
      outcome: 'aborted',
    });
    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, 'session-invalid-goal-finalization')
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes('input-invalid-goal')
      )
    ).toBe(false);
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
