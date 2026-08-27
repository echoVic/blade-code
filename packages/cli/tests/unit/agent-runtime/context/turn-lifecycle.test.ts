import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableSteeringInbox } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import { projectTurnLifecycle } from '../../../../src/context/events/turnLifecycle.js';
import { findPendingSessionInteraction } from '../../../../src/context/interactions.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import {
  PersistentStore,
  PROCESS_RESTART_TOOL_RESULT,
} from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../../src/services/SessionService.js';

async function appendRawTurnAbort(
  workspaceRoot: string,
  sessionId: string,
  turnId: string,
  recovery: unknown,
  acknowledgedInputMessageIds?: unknown
): Promise<void> {
  const timestamp = new Date().toISOString();
  await appendFile(
    getSessionFilePath(workspaceRoot, sessionId),
    `${JSON.stringify({
      id: `raw-abort-${turnId}`,
      sessionId,
      projectPath: workspaceRoot,
      timestamp,
      type: 'turn_aborted',
      cwd: workspaceRoot,
      version: 'test',
      data: {
        turnId,
        cause: 'process_restart',
        abortedAt: timestamp,
        turnsCount: 0,
        toolCallsCount: 0,
        durationMs: 0,
        ...(recovery === undefined ? {} : { recovery }),
        ...(acknowledgedInputMessageIds === undefined
          ? {}
          : { acknowledgedInputMessageIds }),
      },
    })}\n`,
    'utf8'
  );
}

async function appendRawUserMessage(
  workspaceRoot: string,
  sessionId: string,
  messageId: string,
  inboxMessageId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const timestamp = new Date().toISOString();
  await appendFile(
    getSessionFilePath(workspaceRoot, sessionId),
    `${JSON.stringify({
      id: `raw-message-${messageId}`,
      sessionId,
      projectPath: workspaceRoot,
      timestamp,
      type: 'message_created',
      cwd: workspaceRoot,
      version: 'test',
      data: {
        messageId,
        role: 'user',
        inboxMessageId,
        createdAt: timestamp,
        ...(metadata ? { metadata } : {}),
      },
    })}\n`,
    'utf8'
  );
}

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
    await store.saveMessage('session-2', 'user', 'pending input', null, {
      inboxMessageId: 'pending-1',
    });

    const expectedRecovery = {
      turnId: 'turn-orphan',
      outcome: 'aborted' as const,
      inputMessageIds: ['pending-1'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    };
    await expect(store.recoverInterruptedTurn('session-2')).resolves.toEqual(
      expectedRecovery
    );
    await expect(store.recoverInterruptedTurn('session-2')).resolves.toEqual(
      expectedRecovery
    );
    await store.acknowledgeInboxMessages('session-2', ['pending-1']);
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

  it('recovers turn-scoped successful tool evidence with its input identity', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-successful-tool-recovery', {
      turnId: 'turn-successful-tool-recovery',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: ['pending-successful-tool'],
    });
    await store.saveMessage(
      'session-successful-tool-recovery',
      'user',
      'pending input',
      null,
      { inboxMessageId: 'pending-successful-tool' }
    );
    const toolCallId = await store.saveToolUse(
      'session-successful-tool-recovery',
      'Read',
      { file_path: '/workspace/package.json' }
    );
    await store.saveToolResult(
      'session-successful-tool-recovery',
      toolCallId,
      'Read',
      'package contents'
    );

    await expect(
      store.recoverInterruptedTurn('session-successful-tool-recovery')
    ).resolves.toEqual({
      turnId: 'turn-successful-tool-recovery',
      outcome: 'aborted',
      inputMessageIds: ['pending-successful-tool'],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: false,
    });
  });

  it('returns dangerous inputless recovery immediately from an explicit abort', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-inputless-tool-abort';
    const turnId = 'turn-inputless-tool-abort';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'goal',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Write',
      { file_path: '/workspace/result.txt', content: 'done' },
      null
    );
    await store.saveToolResult(sessionId, toolCallId, 'Write', 'written');

    const abort = await store.saveTurnAbort(sessionId, {
      turnId,
      cause: 'failed',
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 1,
      durationMs: 1,
    });

    expect(abort.recovery).toEqual({
      turnId,
      outcome: 'aborted',
      inputMessageIds: [],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: false,
    });
    await expect(store.hasRecoverableTurn(sessionId)).resolves.toBe(true);
    await store.acknowledgeTurnRecovery(sessionId, turnId);
    await expect(store.hasRecoverableTurn(sessionId)).resolves.toBe(false);
  });

  it('does not treat a raw tool result without an error field as successful', async () => {
    const sessionId = 'session-missing-tool-result-error';
    const turnId = 'turn-missing-tool-result-error';
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const assistantMessageId = await store.saveMessage(sessionId, 'assistant', '');
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Read',
      { file_path: '/workspace/package.json' },
      assistantMessageId
    );
    const timestamp = new Date().toISOString();
    await appendFile(
      getSessionFilePath(workspaceRoot, sessionId),
      `${JSON.stringify({
        id: 'raw-tool-result-without-error',
        sessionId,
        projectPath: workspaceRoot,
        timestamp,
        type: 'part_created',
        cwd: workspaceRoot,
        version: 'test',
        data: {
          partId: toolCallId,
          messageId: assistantMessageId,
          partType: 'tool_result',
          payload: {
            toolCallId,
            toolName: 'Read',
            output: 'package contents',
          },
          createdAt: timestamp,
        },
      })}\n`,
      'utf8'
    );

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual({
      turnId,
      outcome: 'aborted',
      inputMessageIds: [],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toHaveLength(1);
  });

  it('uses top-level inbox IDs in restart and explicit abort receipts', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-top-level-inbox-receipts';

    await store.saveTurnStart(sessionId, {
      turnId: 'turn-top-level-restart',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    await appendRawUserMessage(
      workspaceRoot,
      sessionId,
      'message-top-level-restart',
      'input-top-level-restart'
    );

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      turnId: 'turn-top-level-restart',
      inputMessageIds: ['input-top-level-restart'],
    });

    let events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.find(
        (event) =>
          event.type === 'turn_aborted' &&
          event.data.turnId === 'turn-top-level-restart'
      )
    ).toMatchObject({
      data: {
        recovery: { inputMessageIds: ['input-top-level-restart'] },
      },
    });

    await store.saveTurnStart(sessionId, {
      turnId: 'turn-top-level-explicit-abort',
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawUserMessage(
      workspaceRoot,
      sessionId,
      'message-top-level-explicit-abort',
      'input-top-level-explicit-abort',
      { inboxMessageId: 'input-conflicting-metadata' }
    );

    await expect(
      store.saveTurnAbort(sessionId, {
        turnId: 'turn-top-level-explicit-abort',
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      })
    ).resolves.toMatchObject({
      recovery: { inputMessageIds: ['input-top-level-explicit-abort'] },
    });

    events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.find(
        (event) =>
          event.type === 'turn_aborted' &&
          event.data.turnId === 'turn-top-level-explicit-abort'
      )
    ).toMatchObject({
      data: {
        recovery: { inputMessageIds: ['input-top-level-explicit-abort'] },
      },
    });
  });

  it('does not inherit successful tool evidence from an earlier durable turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-scoped-tool-recovery', {
      turnId: 'turn-earlier',
      kind: 'user',
      startedAt: new Date(Date.now() - 3_000).toISOString(),
      inputMessageIds: ['input-earlier'],
    });
    await store.saveMessage(
      'session-scoped-tool-recovery',
      'user',
      'earlier input',
      null,
      { inboxMessageId: 'input-earlier' }
    );
    const earlierToolCallId = await store.saveToolUse(
      'session-scoped-tool-recovery',
      'Read',
      { file_path: '/workspace/earlier.txt' }
    );
    await store.saveToolResult(
      'session-scoped-tool-recovery',
      earlierToolCallId,
      'Read',
      'earlier success'
    );
    await store.saveTurnCompletion(
      'session-scoped-tool-recovery',
      {
        turnId: 'turn-earlier',
        completedAt: new Date(Date.now() - 2_000).toISOString(),
        turnsCount: 2,
        toolCallsCount: 1,
        durationMs: 1_000,
      },
      ['input-earlier']
    );
    await store.saveTurnStart('session-scoped-tool-recovery', {
      turnId: 'turn-current',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: ['input-current'],
    });
    await store.saveMessage(
      'session-scoped-tool-recovery',
      'user',
      'current input',
      null,
      { inboxMessageId: 'input-current' }
    );
    const currentToolCallId = await store.saveToolUse(
      'session-scoped-tool-recovery',
      'Read',
      { file_path: '/workspace/current.txt' }
    );
    await store.saveToolResult(
      'session-scoped-tool-recovery',
      currentToolCallId,
      'Read',
      null,
      null,
      'current failure'
    );

    await expect(
      store.recoverInterruptedTurn('session-scoped-tool-recovery')
    ).resolves.toEqual({
      turnId: 'turn-current',
      outcome: 'aborted',
      inputMessageIds: ['input-current'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });
  });

  it('recovers a spent empty-final correction only from the active turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-empty-final-correction', {
      turnId: 'turn-empty-final-correction',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: ['pending-empty-final-correction'],
    });
    await store.saveMessage(
      'session-empty-final-correction',
      'user',
      'pending input',
      null,
      { inboxMessageId: 'pending-empty-final-correction' }
    );
    await store.saveMessage(
      'session-empty-final-correction',
      'user',
      'internal corrective',
      null,
      { clientVisible: false, emptyFinalCorrection: true }
    );

    await expect(
      store.recoverInterruptedTurn('session-empty-final-correction')
    ).resolves.toEqual({
      turnId: 'turn-empty-final-correction',
      outcome: 'aborted',
      inputMessageIds: ['pending-empty-final-correction'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: true,
    });
  });

  it('preserves empty-final recovery authority across a second restart', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-double-restart', {
      turnId: 'turn-double-restart',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: ['pending-double-restart'],
    });
    await store.saveMessage('session-double-restart', 'user', 'pending input', null, {
      inboxMessageId: 'pending-double-restart',
    });
    const toolCallId = await store.saveToolUse('session-double-restart', 'Read', {
      file_path: '/workspace/package.json',
    });
    await store.saveToolResult(
      'session-double-restart',
      toolCallId,
      'Read',
      'package contents'
    );
    await store.saveMessage(
      'session-double-restart',
      'user',
      'internal corrective',
      null,
      { clientVisible: false, emptyFinalCorrection: true }
    );

    const expected = {
      turnId: 'turn-double-restart',
      outcome: 'aborted' as const,
      inputMessageIds: ['pending-double-restart'],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: true,
    };
    await expect(
      store.recoverInterruptedTurn('session-double-restart')
    ).resolves.toEqual(expected);
    await expect(
      store.recoverInterruptedTurn('session-double-restart')
    ).resolves.toEqual(expected);
  });

  it('inherits recovery authority when a recovered active turn crashes again', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-recovered-turn-crashes-again';
    const inputMessageId = 'input-recovered-turn-crashes-again';
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-original',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      inputMessageIds: [inputMessageId],
    });
    await store.saveMessage(sessionId, 'user', 'original input', null, {
      inboxMessageId: inputMessageId,
    });
    const toolCallId = await store.saveToolUse(sessionId, 'Read', {
      file_path: '/workspace/package.json',
    });
    await store.saveToolResult(sessionId, toolCallId, 'Read', 'package contents');
    await store.saveMessage(sessionId, 'user', 'internal corrective', null, {
      clientVisible: false,
      emptyFinalCorrection: true,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual({
      turnId: 'turn-original',
      outcome: 'aborted',
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: true,
    });
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-recovered',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: [inputMessageId],
    });

    const expectedRecovery = {
      turnId: 'turn-recovered',
      outcome: 'aborted' as const,
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: true,
    };
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual(
      expectedRecovery
    );
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual(
      expectedRecovery
    );

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events
        .filter((event) => event.type === 'turn_aborted')
        .map((event) => ({ turnId: event.data.turnId, recovery: event.data.recovery }))
    ).toEqual([
      {
        turnId: 'turn-original',
        recovery: {
          version: 2,
          inputMessageIds: [inputMessageId],
          hadSuccessfulToolResult: true,
          interruptedToolCallCount: 0,
          emptyFinalCorrectionSpent: true,
        },
      },
      {
        turnId: 'turn-recovered',
        recovery: {
          version: 2,
          inputMessageIds: [inputMessageId],
          hadSuccessfulToolResult: true,
          interruptedToolCallCount: 0,
          emptyFinalCorrectionSpent: true,
        },
      },
    ]);
  });

  it('keeps the latest still-unacknowledged recovery across a newer empty receipt', async () => {
    const sessionId = 'session-newer-empty-receipt';
    const inbox = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    await inbox.enqueue({
      id: 'input-a',
      content: 'input a',
      queuedAt: Date.now(),
    });
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-a',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      inputMessageIds: ['input-a'],
    });
    await store.saveMessage(sessionId, 'user', 'input a', null, {
      inboxMessageId: 'input-a',
    });
    await store.saveTurnAbort(sessionId, {
      turnId: 'turn-a',
      cause: 'failed',
      abortedAt: new Date(Date.now() - 1_500).toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    });
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-b',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: [],
    });
    await store.saveTurnAbort(sessionId, {
      turnId: 'turn-b',
      cause: 'failed',
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual({
      turnId: 'turn-a',
      outcome: 'aborted',
      inputMessageIds: ['input-a'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });
    const reopened = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ id: 'input-a', recovered: true }),
    ]);
  });

  it('does not revive an older recovery after the same input is acknowledged', async () => {
    const sessionId = 'session-newer-acknowledged-receipt';
    const inbox = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    await inbox.enqueue({
      id: 'input-a',
      content: 'input a',
      queuedAt: Date.now(),
    });
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-a',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      inputMessageIds: ['input-a'],
    });
    await store.saveMessage(sessionId, 'user', 'input a', null, {
      inboxMessageId: 'input-a',
    });
    await store.saveTurnAbort(sessionId, {
      turnId: 'turn-a',
      cause: 'failed',
      abortedAt: new Date(Date.now() - 1_500).toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    });
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-b',
      kind: 'pending',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: ['input-a'],
    });
    await store.saveTurnAbort(
      sessionId,
      {
        turnId: 'turn-b',
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
        recovery: {
          version: 1,
          inputMessageIds: ['input-a'],
          hadSuccessfulToolResult: false,
          emptyFinalCorrectionSpent: false,
        },
      },
      { acknowledgeInputMessageIds: ['input-a'] }
    );

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toBeUndefined();
    const reopened = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    expect(reopened.list()).toEqual([]);
  });

  it.each([
    ['null receipt', null],
    ['missing receipt', undefined],
    ['missing receipt fields', { version: 1, inputMessageIds: ['missing-booleans'] }],
    [
      'non-string input identity',
      {
        version: 1,
        inputMessageIds: ['valid-id', 42],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'wrong boolean field',
      {
        version: 1,
        inputMessageIds: ['wrong-boolean'],
        hadSuccessfulToolResult: 'false',
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'more than the mailbox capacity of input identities',
      {
        version: 1,
        inputMessageIds: Array.from(
          { length: 121 },
          (_, index) => `too-many-input-${index}`
        ),
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'overlong input identity',
      {
        version: 1,
        inputMessageIds: ['x'.repeat(129)],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'v2 receipt with missing interrupted tool count',
      {
        version: 2,
        inputMessageIds: ['missing-v2-count'],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'v2 receipt with negative interrupted tool count',
      {
        version: 2,
        inputMessageIds: ['negative-v2-count'],
        hadSuccessfulToolResult: false,
        interruptedToolCallCount: -1,
        emptyFinalCorrectionSpent: false,
      },
    ],
    [
      'unknown receipt version',
      {
        version: 3,
        inputMessageIds: ['unknown-version'],
        hadSuccessfulToolResult: false,
        interruptedToolCallCount: 0,
        emptyFinalCorrectionSpent: false,
      },
    ],
  ])(
    'ignores a legacy abort with %s without blocking the session',
    async (_, receipt) => {
      const sessionId = `session-malformed-abort-${String(_).replaceAll(' ', '-')}`;
      const turnId = `turn-malformed-abort-${String(_).replaceAll(' ', '-')}`;
      const store = new PersistentStore(workspaceRoot);
      await store.initialize();
      await store.saveTurnStart(sessionId, {
        turnId,
        kind: 'user',
        startedAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await appendRawTurnAbort(workspaceRoot, sessionId, turnId, receipt);

      await expect(store.recoverInterruptedTurn(sessionId)).resolves.toBeUndefined();
      await expect(store.loadSession(sessionId)).resolves.toMatchObject({ sessionId });
    }
  );

  it('accepts a recovery receipt at the mailbox capacity', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-max-recovery-receipt';
    const turnId = 'turn-max-recovery-receipt';
    const inputMessageIds = Array.from(
      { length: 120 },
      (_, index) => `max-recovery-input-${index}`
    );
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawTurnAbort(workspaceRoot, sessionId, turnId, {
      version: 1,
      inputMessageIds,
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      inputMessageIds,
    });
  });

  it.each([
    ['not an array', 'invalid'],
    ['too many IDs', Array.from({ length: 121 }, (_, index) => `ack-${index}`)],
    ['an empty ID', ['']],
    ['an overlong ID', ['x'.repeat(129)]],
  ])('ignores embedded abort acknowledgements with %s', async (_, acknowledged) => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = `session-malformed-embedded-ack-${String(_).replaceAll(' ', '-')}`;
    const turnId = `turn-malformed-embedded-ack-${String(_).replaceAll(' ', '-')}`;
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawTurnAbort(
      workspaceRoot,
      sessionId,
      turnId,
      {
        version: 1,
        inputMessageIds: ['must-remain-pending'],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      acknowledged
    );

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      inputMessageIds: ['must-remain-pending'],
    });
  });

  it('scopes embedded abort acknowledgements to the same recovery receipt', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-cross-turn-embedded-ack';
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-a',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    await appendRawTurnAbort(
      workspaceRoot,
      sessionId,
      'turn-a',
      {
        version: 1,
        inputMessageIds: ['input-a'],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      ['input-b']
    );
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-b',
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawTurnAbort(workspaceRoot, sessionId, 'turn-b', {
      version: 1,
      inputMessageIds: ['input-b'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      turnId: 'turn-b',
      inputMessageIds: ['input-b'],
    });
  });

  it('keeps inbox input when another abort receipt claims its acknowledgement', async () => {
    const sessionId = 'session-cross-turn-inbox-ack';
    const inbox = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    await inbox.enqueue({
      id: 'input-b',
      content: 'must remain pending',
      queuedAt: Date.now(),
    });
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-a',
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawTurnAbort(
      workspaceRoot,
      sessionId,
      'turn-a',
      {
        version: 1,
        inputMessageIds: ['input-a'],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      ['input-b']
    );

    const reopened = await DurableSteeringInbox.open(workspaceRoot, sessionId);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ id: 'input-b', recovered: true }),
    ]);
  });

  it('does not let an unapplied abort acknowledgement filter a later recovery', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-unapplied-abort-ack';
    const inputMessageId = 'input-reused-after-unapplied-abort';
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-without-applied-input',
      kind: 'user',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    await appendRawTurnAbort(
      workspaceRoot,
      sessionId,
      'turn-without-applied-input',
      {
        version: 1,
        inputMessageIds: [inputMessageId],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      [inputMessageId]
    );
    await store.saveTurnStart(sessionId, {
      turnId: 'turn-with-applied-input',
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await appendRawUserMessage(
      workspaceRoot,
      sessionId,
      'message-with-top-level-inbox-id',
      inputMessageId
    );
    await appendRawTurnAbort(workspaceRoot, sessionId, 'turn-with-applied-input', {
      version: 1,
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      turnId: 'turn-with-applied-input',
      inputMessageIds: [inputMessageId],
    });
  });

  it('includes only steering inbox identities actually applied in the active turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    await store.saveTurnStart('session-goal-steering-restart', {
      turnId: 'turn-goal-steering-restart',
      kind: 'goal',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(
      'session-goal-steering-restart',
      'user',
      'applied steering',
      null,
      { inboxMessageId: 'applied-steering' }
    );

    await expect(
      store.recoverInterruptedTurn('session-goal-steering-restart')
    ).resolves.toMatchObject({
      inputMessageIds: ['applied-steering'],
    });
  });

  it('persists only applied goal-turn input identities in an abort receipt', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-goal-abort-receipt';
    const turnId = 'turn-goal-abort-receipt';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'goal',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'applied steering', null, {
      inboxMessageId: 'applied-id',
    });
    const toolCallId = await store.saveToolUse(sessionId, 'Read', {
      file_path: '/workspace/package.json',
    });
    await store.saveToolResult(sessionId, toolCallId, 'Read', 'package contents');

    await expect(
      store.saveTurnAbort(sessionId, {
        turnId,
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 1,
        recovery: {
          version: 1,
          inputMessageIds: ['applied-id', 'claimed-but-never-applied'],
          hadSuccessfulToolResult: false,
          emptyFinalCorrectionSpent: false,
        },
      })
    ).resolves.toEqual({
      recovery: {
        turnId,
        outcome: 'aborted',
        inputMessageIds: ['applied-id'],
        hadSuccessfulToolResult: true,
        emptyFinalCorrectionSpent: false,
      },
      acknowledgedInputMessageIds: [],
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(events.find((event) => event.type === 'turn_aborted')).toMatchObject({
      data: {
        recovery: {
          inputMessageIds: ['applied-id'],
          hadSuccessfulToolResult: true,
        },
      },
    });
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

    const expectedRecovery = {
      turnId: 'turn-tool-crash',
      outcome: 'aborted' as const,
      inputMessageIds: [],
      hadSuccessfulToolResult: false,
      interruptedToolCallCount: 1,
      emptyFinalCorrectionSpent: false,
    };
    await expect(store.recoverInterruptedTurn('session-tool-crash')).resolves.toEqual(
      expectedRecovery
    );
    await expect(store.recoverInterruptedTurn('session-tool-crash')).resolves.toEqual(
      expectedRecovery
    );
    await store.acknowledgeTurnRecovery('session-tool-crash', expectedRecovery.turnId);
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

  it('recovers v1 interrupted-tool risk from its synthetic restart result', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-v1-interrupted-tool';
    const turnId = 'turn-v1-interrupted-tool';
    const inputMessageId = 'input-v1-interrupted-tool';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      inputMessageIds: [inputMessageId],
    });
    await store.saveMessage(sessionId, 'user', 'continue safely', null, {
      inboxMessageId: inputMessageId,
    });
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Write',
      { file_path: '/workspace/result.txt', content: 'done' },
      null
    );
    await store.saveToolResult(
      sessionId,
      toolCallId,
      'Write',
      null,
      toolCallId,
      PROCESS_RESTART_TOOL_RESULT,
      undefined,
      undefined,
      { processRestartRecovery: true, sideEffectsUncertain: true }
    );
    await appendRawTurnAbort(workspaceRoot, sessionId, turnId, {
      version: 1,
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
    });

    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual({
      turnId,
      outcome: 'aborted',
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: false,
      interruptedToolCallCount: 1,
      emptyFinalCorrectionSpent: false,
    });
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
    const expectedRecovery = {
      turnId: 'turn-task-adoption',
      outcome: 'aborted' as const,
      inputMessageIds: [],
      hadSuccessfulToolResult: true,
      emptyFinalCorrectionSpent: false,
    };
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
    ).resolves.toEqual(expectedRecovery);
    await expect(
      store.recoverInterruptedTurn('session-task-adoption')
    ).resolves.toEqual(expectedRecovery);
    await store.acknowledgeTurnRecovery(
      'session-task-adoption',
      expectedRecovery.turnId
    );
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

  it('atomically persists one hidden background completion and terminal child reference', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-background-completion';
    const childSessionId = 'agent-background-completion';
    const assistantMessageId = await store.saveMessage(sessionId, 'assistant', '');
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Inspect background marker',
        prompt: 'Inspect the project and return the background marker.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
        run_in_background: true,
      },
      assistantMessageId
    );
    await store.saveToolResult(
      sessionId,
      toolCallId,
      'Task',
      {
        agent_id: childSessionId,
        status: 'running',
      },
      assistantMessageId,
      undefined,
      undefined,
      {
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentDescription: 'Inspect background marker',
        subagentStatus: 'running',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      },
      {
        background: true,
        subagentSessionId: childSessionId,
      }
    );
    const completion = {
      inboxMessageId: 'background-subagent-completion:agent-background-completion',
      childSessionId,
      content:
        '<background-subagent-completion>{"result":"BACKGROUND_CHILD_MARKER"}</background-subagent-completion>',
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId,
          subagentType: 'Explore',
          description: 'Inspect background marker',
          status: 'completed',
          rootAgentId: childSessionId,
          resumeDepth: 0,
          resultTruncated: false,
        },
      },
      subagentRef: {
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentDescription: 'Inspect background marker',
        subagentStatus: 'completed' as const,
        subagentSummary: 'BACKGROUND_CHILD_MARKER',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      },
    };

    const first = await store.persistBackgroundSubagentCompletion(
      sessionId,
      completion
    );
    const second = await store.persistBackgroundSubagentCompletion(
      sessionId,
      completion
    );

    expect(first).toMatchObject({
      eligible: true,
      acknowledged: false,
      persisted: true,
      messageId: expect.any(String),
    });
    expect(second).toEqual({
      ...first,
      persisted: false,
    });

    let events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    const completionMessages = events.filter(
      (event) =>
        event.type === 'message_created' &&
        event.data.inboxMessageId === completion.inboxMessageId
    );
    const terminalRefs = events.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'subtask_ref' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.childSessionId === childSessionId &&
        event.data.payload.status === 'completed'
    );
    expect(completionMessages).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          role: 'user',
          metadata: expect.objectContaining({
            clientVisible: false,
            backgroundSubagentCompletion: expect.objectContaining({
              childSessionId,
            }),
          }),
        }),
      }),
    ]);
    expect(terminalRefs).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          messageId: assistantMessageId,
          payload: expect.objectContaining({
            childSessionId,
            status: 'completed',
            summary: 'BACKGROUND_CHILD_MARKER',
          }),
        }),
      }),
    ]);
    expect(terminalRefs[0]!.seq).toBe(completionMessages[0]!.seq! + 2);
    expect(
      SessionService.toUISafeMessages(SessionService.convertJSONLToMessages(events))
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('BACKGROUND_CHILD_MARKER'),
        }),
      ])
    );
    expect(JSON.stringify(SessionService.convertJSONLToModelContext(events))).toContain(
      'BACKGROUND_CHILD_MARKER'
    );

    await store.acknowledgeInboxMessages(sessionId, [completion.inboxMessageId]);
    await expect(
      store.persistBackgroundSubagentCompletion(sessionId, completion)
    ).resolves.toMatchObject({
      eligible: true,
      acknowledged: true,
      persisted: false,
      messageId: first.messageId,
    });
    events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.filter(
        (event) =>
          event.type === 'message_created' &&
          event.data.inboxMessageId === completion.inboxMessageId
      )
    ).toHaveLength(1);
  });

  it('does not let a late background Task running result downgrade its terminal ref', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-background-terminal-before-result';
    const childSessionId = 'agent-background-terminal-before-result';
    const assistantMessageId = await store.saveMessage(sessionId, 'assistant', '');
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Read terminal marker',
        prompt: 'Read and return the terminal marker.',
        subagent_type: 'Explore',
        subagent_session_id: childSessionId,
        run_in_background: true,
      },
      assistantMessageId
    );
    const completion = {
      inboxMessageId: `background-subagent-completion:${childSessionId}`,
      childSessionId,
      content:
        '<background-subagent-completion>{"result":"TERMINAL_BEFORE_RUNNING_RESULT"}</background-subagent-completion>',
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId,
          status: 'completed',
          result: 'TERMINAL_BEFORE_RUNNING_RESULT',
        },
      },
      subagentRef: {
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentDescription: 'Read terminal marker',
        subagentStatus: 'completed' as const,
        subagentSummary: 'TERMINAL_BEFORE_RUNNING_RESULT',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      },
    };
    await expect(
      store.persistBackgroundSubagentCompletion(sessionId, completion)
    ).resolves.toMatchObject({ eligible: true, persisted: true });

    await store.saveToolResult(
      sessionId,
      toolCallId,
      'Task',
      {
        agent_id: childSessionId,
        status: 'running',
      },
      assistantMessageId,
      undefined,
      undefined,
      {
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentDescription: 'Read terminal marker',
        subagentStatus: 'running',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      },
      {
        background: true,
        subagentSessionId: childSessionId,
        subagentType: 'Explore',
        subagentStatus: 'running',
        subagentRootId: childSessionId,
        subagentResumeDepth: 0,
      }
    );

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'subtask_ref' &&
          event.data.payload !== null &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.childSessionId === childSessionId &&
          event.data.payload.status === 'completed'
      )
    ).toHaveLength(1);
    expect(
      events.findLast(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toMatchObject({
      data: {
        payload: {
          metadata: {
            background: true,
            subagentSessionId: childSessionId,
            subagentStatus: 'completed',
            subagentSummary: 'TERMINAL_BEFORE_RUNNING_RESULT',
          },
        },
      },
    });
    expect(
      SessionService.convertJSONLToMessages(events).find(
        (message) =>
          message.role === 'assistant' &&
          message.metadata !== null &&
          typeof message.metadata === 'object' &&
          !Array.isArray(message.metadata) &&
          'subtaskRef' in message.metadata
      )
    ).toMatchObject({
      metadata: {
        subtaskRef: {
          childSessionId,
          status: 'completed',
          summary: 'TERMINAL_BEFORE_RUNNING_RESULT',
        },
      },
    });
  });

  it('rejects a completion without a matching committed background Task call', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-foreground-completion';
    const assistantMessageId = await store.saveMessage(sessionId, 'assistant', '');
    await store.saveToolUse(
      sessionId,
      'Task',
      {
        description: 'Inspect foreground marker',
        prompt: 'Inspect the project and return the foreground marker.',
        subagent_type: 'Explore',
        subagent_session_id: 'agent-foreground-completion',
        run_in_background: false,
      },
      assistantMessageId
    );

    await expect(
      store.persistBackgroundSubagentCompletion(sessionId, {
        inboxMessageId: 'background-subagent-completion:agent-foreground-completion',
        childSessionId: 'agent-foreground-completion',
        content: 'must not be persisted',
        metadata: {
          clientVisible: false,
          backgroundSubagentCompletion: {
            childSessionId: 'agent-foreground-completion',
          },
        },
        subagentRef: {
          subagentSessionId: 'agent-foreground-completion',
          subagentType: 'Explore',
          subagentDescription: 'Inspect foreground marker',
          subagentStatus: 'completed',
          subagentRootId: 'agent-foreground-completion',
          subagentResumeDepth: 0,
        },
      })
    ).resolves.toEqual({
      eligible: false,
      acknowledged: false,
      persisted: false,
    });
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

  it('atomically acknowledges missing input before aborting a turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-atomic-abort-ack';
    const turnId = 'turn-atomic-abort-ack';
    await store.acknowledgeInboxMessages(sessionId, ['already-acknowledged']);
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'applied input', null, {
      inboxMessageId: 'applied-input',
    });
    const abort = {
      turnId,
      cause: 'failed' as const,
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    };

    await store.saveTurnAbort(sessionId, abort, {
      acknowledgeInputMessageIds: [
        'already-acknowledged',
        'applied-input',
        'applied-input',
      ],
    });
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toBeUndefined();
    await store.saveTurnAbort(sessionId, abort, {
      acknowledgeInputMessageIds: ['applied-input'],
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    const terminal = events.find(
      (event) => event.type === 'turn_aborted' && event.data.turnId === turnId
    );
    const acknowledgement = events.find(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes('applied-input')
    );
    expect(acknowledgement).toMatchObject({
      data: { messageIds: ['applied-input'] },
    });
    expect(terminal).toMatchObject({
      data: { acknowledgedInputMessageIds: ['applied-input'] },
    });
    expect(acknowledgement?.seq).toBe((terminal?.seq ?? 0) + 1);
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes('applied-input')
      )
    ).toHaveLength(1);
  });

  it('ignores caller-supplied abort acknowledgements without options', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-untrusted-embedded-abort-ack';
    const turnId = 'turn-untrusted-embedded-abort-ack';
    const inputMessageId = 'input-untrusted-embedded-abort-ack';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'applied input', null, {
      inboxMessageId: inputMessageId,
    });

    await expect(
      store.saveTurnAbort(sessionId, {
        turnId,
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
        acknowledgedInputMessageIds: [inputMessageId],
      })
    ).resolves.toEqual({
      recovery: {
        turnId,
        outcome: 'aborted',
        inputMessageIds: [inputMessageId],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      acknowledgedInputMessageIds: [],
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    const terminal = events.find(
      (event) => event.type === 'turn_aborted' && event.data.turnId === turnId
    );
    expect(terminal?.data).not.toHaveProperty('acknowledgedInputMessageIds');
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      turnId,
      inputMessageIds: [inputMessageId],
    });
  });

  it('adds a missing acknowledgement to an existing aborted turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-abort-then-ack';
    const turnId = 'turn-abort-then-ack';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'applied input', null, {
      inboxMessageId: 'input-to-ack',
    });
    const abort = {
      turnId,
      cause: 'failed' as const,
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    };

    await store.saveTurnAbort(sessionId, abort);
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toMatchObject({
      turnId,
      inputMessageIds: ['input-to-ack'],
    });
    await expect(
      store.saveTurnAbort(sessionId, abort, {
        acknowledgeInputMessageIds: ['input-to-ack'],
      })
    ).resolves.toEqual({ acknowledgedInputMessageIds: ['input-to-ack'] });
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toBeUndefined();

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes('input-to-ack')
      )
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ messageIds: ['input-to-ack'] }),
      }),
    ]);
  });

  it('adds only missing acknowledgements to an existing aborted turn', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-abort-partial-ack';
    const turnId = 'turn-abort-partial-ack';
    await store.acknowledgeInboxMessages(sessionId, ['already-acknowledged']);
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'already acknowledged input', null, {
      inboxMessageId: 'already-acknowledged',
    });
    await store.saveMessage(sessionId, 'user', 'missing acknowledgement', null, {
      inboxMessageId: 'missing-acknowledgement',
    });
    const abort = {
      turnId,
      cause: 'failed' as const,
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    };
    await store.saveTurnAbort(sessionId, abort);

    await expect(
      store.saveTurnAbort(sessionId, abort, {
        acknowledgeInputMessageIds: ['already-acknowledged', 'missing-acknowledgement'],
      })
    ).resolves.toEqual({
      acknowledgedInputMessageIds: ['already-acknowledged', 'missing-acknowledgement'],
    });

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'inbox_acknowledged')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ messageIds: ['already-acknowledged'] }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ messageIds: ['missing-acknowledgement'] }),
      }),
    ]);
  });

  it.each([
    ['too many IDs', Array.from({ length: 121 }, (_, index) => `abort-ack-${index}`)],
    ['an overlong ID', ['x'.repeat(129)]],
  ])('rejects abort acknowledgement options with %s', async (_, messageIds) => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = `session-invalid-abort-ack-${String(_).replaceAll(' ', '-')}`;
    const turnId = `turn-invalid-abort-ack-${String(_).replaceAll(' ', '-')}`;
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(
      store.saveTurnAbort(
        sessionId,
        {
          turnId,
          cause: 'failed',
          abortedAt: new Date().toISOString(),
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1,
        },
        { acknowledgeInputMessageIds: messageIds }
      )
    ).rejects.toThrow('Invalid turn abort acknowledgement input message IDs');
    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_aborted')).toEqual([]);
  });

  it('accepts abort acknowledgement options at the mailbox capacity', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-max-abort-ack';
    const turnId = 'turn-max-abort-ack';
    const inputMessageIds = Array.from(
      { length: 120 },
      (_, index) => `max-abort-ack-${index}`
    );
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(
      store.saveTurnAbort(
        sessionId,
        {
          turnId,
          cause: 'failed',
          abortedAt: new Date().toISOString(),
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1,
        },
        { acknowledgeInputMessageIds: inputMessageIds }
      )
    ).resolves.toBeDefined();
  });

  it('treats abort after completion as a terminal no-op', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-completion-before-abort';
    const turnId = 'turn-completion-before-abort';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.saveTurnCompletion(sessionId, {
      turnId,
      completedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 1,
    });

    await expect(
      store.saveTurnAbort(
        sessionId,
        {
          turnId,
          cause: 'failed',
          abortedAt: new Date().toISOString(),
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1,
        },
        { acknowledgeInputMessageIds: ['must-not-be-acknowledged'] }
      )
    ).resolves.toEqual({ acknowledgedInputMessageIds: [] });
    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'inbox_acknowledged')).toEqual([]);
  });

  it('returns only the matching unacknowledged receipt for a duplicate abort', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-duplicate-abort-receipt';
    const abort = async (turnId: string, inputMessageId: string) => {
      await store.saveTurnStart(sessionId, {
        turnId,
        kind: 'user',
        startedAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await store.saveMessage(sessionId, 'user', inputMessageId, null, {
        inboxMessageId: inputMessageId,
      });
      return store.saveTurnAbort(sessionId, {
        turnId,
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      });
    };
    await abort('turn-first-abort', 'input-first-abort');
    await abort('turn-second-abort', 'input-second-abort');

    await expect(
      store.saveTurnAbort(sessionId, {
        turnId: 'turn-first-abort',
        cause: 'failed',
        abortedAt: new Date().toISOString(),
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1,
      })
    ).resolves.toEqual({
      recovery: {
        turnId: 'turn-first-abort',
        outcome: 'aborted',
        inputMessageIds: ['input-first-abort'],
        hadSuccessfulToolResult: false,
        emptyFinalCorrectionSpent: false,
      },
      acknowledgedInputMessageIds: [],
    });
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

    const expectedRecovery = {
      turnId: 'turn-terminal-orphan',
      outcome: 'aborted' as const,
      inputMessageIds: [],
      hadSuccessfulToolResult: false,
      interruptedToolCallCount: 2,
      emptyFinalCorrectionSpent: false,
    };
    await expect(
      store.recoverInterruptedTurn('session-terminal-orphan')
    ).resolves.toEqual(expectedRecovery);
    await expect(
      store.recoverInterruptedTurn('session-terminal-orphan')
    ).resolves.toEqual(expectedRecovery);
    await store.acknowledgeTurnRecovery(
      'session-terminal-orphan',
      expectedRecovery.turnId
    );
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

  it('returns an aborted recovery while repairing its terminal orphan tool', async () => {
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();
    const sessionId = 'session-terminal-orphan-recovery';
    const turnId = 'turn-terminal-orphan-recovery';
    const inputMessageId = 'input-terminal-orphan-recovery';
    await store.saveTurnStart(sessionId, {
      turnId,
      kind: 'user',
      startedAt: new Date().toISOString(),
    });
    await store.saveMessage(sessionId, 'user', 'recover safely', null, {
      inboxMessageId: inputMessageId,
    });
    const toolCallId = await store.saveToolUse(
      sessionId,
      'Write',
      { file_path: '/workspace/result.txt', content: 'done' },
      null
    );
    await store.saveTurnAbort(sessionId, {
      turnId,
      cause: 'failed',
      abortedAt: new Date().toISOString(),
      turnsCount: 1,
      toolCallsCount: 1,
      durationMs: 1,
    });

    const expected = {
      turnId,
      outcome: 'aborted' as const,
      inputMessageIds: [inputMessageId],
      hadSuccessfulToolResult: false,
      interruptedToolCallCount: 1,
      emptyFinalCorrectionSpent: false,
    };
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual(expected);
    await expect(store.recoverInterruptedTurn(sessionId)).resolves.toEqual(expected);

    const events = await new JSONLStore(
      getSessionFilePath(workspaceRoot, sessionId)
    ).readAll();
    expect(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      )
    ).toHaveLength(1);
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
      'user',
      'input with invalid goal finalization',
      null,
      { inboxMessageId: 'input-invalid-goal' }
    );
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
      inputMessageIds: ['input-invalid-goal'],
      hadSuccessfulToolResult: false,
      emptyFinalCorrectionSpent: false,
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
