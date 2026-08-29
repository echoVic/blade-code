import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  awaitAcpChildShutdown,
  drainChildStderr,
  InvalidRecoveryError,
  inspectAcpFinalMarker,
  inspectAcpPendingResumeEvidence,
  inspectDurableCompletionLifecycle,
  inspectDurableFinalMarker,
  inspectDurableRecoveryResult,
  inspectDurableWriteEvidence,
  parseDurableInteractionRecoveryAcpEvidence,
  parseDurableInteractionRecoveryAcpFailureEvidence,
  parseDurableInteractionRecoveryAcpRunnerInput,
  pollDurableInteractionCompletion,
  recoveryFailureReason,
  SecretScanner,
  serializeDurableInteractionRecoveryAcpEvidence,
  withDurableInteractionStorageRoot,
} from '../../support/durableInteractionRecoveryAcpRunner.js';

vi.unmock('node:child_process');
vi.unmock('child_process');

import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

function eventBase(id: string, type: SessionEvent['type']) {
  return {
    id,
    sessionId: 'durable-acp-session',
    timestamp: '2026-08-29T00:00:00.000Z',
    type,
    cwd: '/tmp/blade/workspace',
    version: 'test',
  };
}

function completionLifecycleEvents(): SessionEvent[] {
  const inboxMessageId = 'interaction-request-1';
  const turnId = 'recovered-turn';
  return [
    {
      ...eventBase('turn-started', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId,
        kind: 'pending',
        startedAt: '2026-08-29T00:00:00.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('inbox-acknowledged', 'inbox_acknowledged'),
      type: 'inbox_acknowledged',
      data: {
        messageIds: [inboxMessageId],
        acknowledgedAt: '2026-08-29T00:00:01.000Z',
      },
    },
    {
      ...eventBase('turn-completed', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId,
        completedAt: '2026-08-29T00:00:02.000Z',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 2_000,
      },
    },
  ];
}

function retryCompletionLifecycleEvents(): SessionEvent[] {
  const inboxMessageId = 'interaction-request-1';
  return [
    {
      ...eventBase('turn-started-attempt-1', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId: 'recovered-turn-attempt-1',
        kind: 'pending',
        startedAt: '2026-08-29T00:00:00.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('turn-aborted-attempt-1', 'turn_aborted'),
      type: 'turn_aborted',
      data: {
        turnId: 'recovered-turn-attempt-1',
        cause: 'failed',
        abortedAt: '2026-08-29T00:00:01.000Z',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1_000,
        recovery: {
          version: 2,
          inputMessageIds: [inboxMessageId],
          hadSuccessfulToolResult: false,
          interruptedToolCallCount: 0,
          emptyFinalCorrectionSpent: false,
        },
      },
    },
    {
      ...eventBase('turn-started-attempt-2', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId: 'recovered-turn-attempt-2',
        kind: 'pending',
        startedAt: '2026-08-29T00:00:02.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('inbox-acknowledged-attempt-2', 'inbox_acknowledged'),
      type: 'inbox_acknowledged',
      data: {
        messageIds: [inboxMessageId],
        acknowledgedAt: '2026-08-29T00:00:03.000Z',
      },
    },
    {
      ...eventBase('turn-completed-attempt-2', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId: 'recovered-turn-attempt-2',
        completedAt: '2026-08-29T00:00:04.000Z',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 2_000,
      },
    },
  ];
}

function finalMessageEvents(turnId: string, marker: string): SessionEvent[] {
  const messageId = `assistant-${turnId}`;
  return [
    {
      ...eventBase(`message-${turnId}`, 'message_created'),
      type: 'message_created',
      data: {
        messageId,
        role: 'assistant',
        createdAt: '2026-08-29T00:00:01.000Z',
        metadata: {
          turnFinalization: {
            turnId,
            inputMessageIds: [],
            turnsCount: 1,
            toolCallsCount: 1,
            durationMs: 2_000,
          },
        },
      },
    },
    {
      ...eventBase(`part-${turnId}`, 'part_created'),
      type: 'part_created',
      data: {
        partId: `part-${turnId}`,
        messageId,
        partType: 'text',
        payload: { text: marker },
        createdAt: '2026-08-29T00:00:01.000Z',
      },
    },
  ];
}

function completionStatusEvent(id: string): SessionEvent {
  return {
    ...eventBase(id, 'session_updated'),
    type: 'session_updated',
    data: {
      sessionId: 'durable-acp-session',
      taskStatus: 'completed',
    },
  };
}

const safeEvidence = {
  success: true,
  sessionId: 'durable-acp-session',
  modeId: 'yolo',
  questionRequests: 1,
  requestMatched: true,
  optionMatched: true,
  pendingResumePhases: ['retry_scheduled', 'recovered'],
  pendingResumeAttempts: [2, 2],
  maxAttempts: 4,
  interactionRequested: 1,
  interactionResponded: 1,
  interactionRecovered: 1,
  recoveryToolResults: 1,
  writeCalls: 1,
  writeResults: 1,
  inboxMissing: true,
  acpFinalMarkerCount: 1,
  durableFinalMarkerCount: 1,
  targetSha256: 'a'.repeat(64),
  targetBytes: 7,
  sessionClosed: true,
  eofClosed: true,
  childExitCode: 0,
  childExitSignal: null,
  termFallbackUsed: false,
  killFallbackUsed: false,
  secretSeen: false,
} as const;

const safeFailureEvidence = {
  success: false,
  stage: 'recovery',
  code: 'timeout',
  reason: 'none',
  timedOut: true,
  secretSeen: false,
  termFallbackUsed: true,
  killFallbackUsed: false,
} as const;

function pendingResumeUpdate(
  phase: string,
  attempt: number,
  maxAttempts = 4,
  kind = 'pending_input'
): acp.SessionNotification {
  return {
    sessionId: 'durable-acp-session',
    update: {
      sessionUpdate: 'session_info_update',
      updatedAt: '2026-08-29T00:00:00.000Z',
      _meta: {
        'blade/pendingResume': { phase, attempt, maxAttempts, kind },
      },
    },
  };
}

function encodedInput(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      cliEntry: '/tmp/blade/dist/blade.js',
      nodeExecutable: '/opt/homebrew/bin/node',
      workspace: '/tmp/blade/workspace',
      home: '/tmp/blade/home',
      storageRoot: '/tmp/blade/storage',
      sessionId: 'durable-acp-session',
      requestId: 'request-1',
      targetPath: '/tmp/blade/workspace/channel.txt',
      answerLabel: 'Stable',
      expectedContent: 'Stable\n',
      finalMarker: 'ACP_DURABLE_COMPLETE',
      secret: 'provider-secret',
      timeoutMs: 270_000,
      ...overrides,
    }),
    'utf8'
  ).toString('base64');
}

describe('durable interaction ACP stdio runner', () => {
  it.each([
    ['pending resume evidence is invalid', 'pending_resume_invalid'],
    ['durable event budget exceeded', 'durable_budget'],
    ['duplicate durable completion evidence', 'duplicate_completion'],
    ['durable completion ordering is invalid', 'completion_order'],
    ['duplicate recovery side effect', 'duplicate_side_effect'],
    ['recovery result evidence is invalid', 'recovery_result_invalid'],
    ['Write evidence is invalid', 'write_invalid'],
    ['final marker does not belong to recovered turn', 'final_turn_mismatch'],
    ['durable final structure is invalid', 'durable_final_structure'],
    ['durable final marker is not exact', 'durable_final_mismatch'],
    ['durable final marker count is invalid', 'durable_marker_count'],
    ['ACP final marker count is invalid', 'acp_marker_count'],
    ['ACP surface text overflowed', 'acp_surface_overflow'],
    ['final marker evidence is invalid', 'final_marker_invalid'],
    ['invalid durable question', 'question_invalid'],
    ['invalid durable question option', 'question_option_invalid'],
    ['unexpected permission request', 'permission_request_invalid'],
    ['permission request does not match interaction', 'permission_request_invalid'],
    ['question option is not exact', 'option_invalid'],
    ['duplicate interaction evidence', 'interaction_duplicate'],
    ['interaction response is invalid', 'interaction_response_invalid'],
    ['interaction recovery is invalid', 'interaction_recovery_invalid'],
    ['durable recovery ordering is invalid', 'recovery_order'],
    ['recovery inbox identity is invalid', 'inbox_identity'],
    ['target content is invalid', 'target_invalid'],
    ['terminal recovery failure', 'terminal_failure'],
    ['ACP child exited before recovery', 'child_early_exit'],
    ['seed is not pending-only', 'seed_invalid'],
    ['target exists before recovery', 'target_exists'],
    ['ACP stdio is unavailable', 'stdio_unavailable'],
    ['ACP session/close is unavailable', 'close_unsupported'],
    ['question callback evidence is invalid', 'callback_invalid'],
    ['ACP child did not exit normally', 'child_exit_invalid'],
  ] as const)('maps %s to the safe failure reason %s', (message, expected) => {
    expect(recoveryFailureReason(new InvalidRecoveryError(message))).toBe(expected);
  });

  it('maps non-recovery and unknown errors to none without exposing messages', () => {
    expect(recoveryFailureReason(new Error('pending resume evidence is invalid'))).toBe(
      'none'
    );
    expect(
      recoveryFailureReason(new InvalidRecoveryError('private unknown failure'))
    ).toBe('none');
    expect(recoveryFailureReason(new Error('private unknown failure'))).toBe('none');
    expect(recoveryFailureReason('private unknown failure')).toBe('none');
  });

  it('parses exact bounded failure evidence', () => {
    expect(
      parseDurableInteractionRecoveryAcpFailureEvidence(
        JSON.stringify(safeFailureEvidence),
        'provider-secret'
      )
    ).toEqual(safeFailureEvidence);
  });

  it.each([
    ['missing field', { ...safeFailureEvidence, timedOut: undefined }],
    ['extra field', { ...safeFailureEvidence, diagnostic: 'private-detail' }],
    ['success true', { ...safeFailureEvidence, success: true }],
    ['unknown stage', { ...safeFailureEvidence, stage: 'private-stage' }],
    ['unknown code', { ...safeFailureEvidence, code: 'private-code' }],
    ['unknown reason', { ...safeFailureEvidence, reason: 'private-reason' }],
    ['non-boolean flag', { ...safeFailureEvidence, killFallbackUsed: 0 }],
  ])('rejects failure evidence with %s without echoing it', (_name, evidence) => {
    const serialized = JSON.stringify(evidence);
    let error: unknown;
    try {
      parseDurableInteractionRecoveryAcpFailureEvidence(serialized, 'provider-secret');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Durable interaction ACP failure evidence is invalid'
    );
    expect((error as Error).message).not.toContain('private-');
  });

  it('rejects oversized failure evidence with a fixed bounded error', () => {
    expect(() =>
      parseDurableInteractionRecoveryAcpFailureEvidence(
        JSON.stringify({ ...safeFailureEvidence, stage: 'x'.repeat(17_000) }),
        'provider-secret'
      )
    ).toThrow(
      'Durable interaction ACP failure evidence exceeded its serialized budget'
    );
  });

  it('secret-scans failure evidence before applying the byte budget', () => {
    const secret = 'provider-secret-material';
    const serialized = JSON.stringify({
      ...safeFailureEvidence,
      stage: secret + 'x'.repeat(17_000),
    });
    let error: unknown;
    try {
      parseDurableInteractionRecoveryAcpFailureEvidence(serialized, secret);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Durable interaction ACP failure evidence contains provider credentials'
    );
    expect((error as Error).message).not.toContain(secret);
  });

  it('projects the exact bounded pending-resume failure recovery sequence', () => {
    expect(
      inspectAcpPendingResumeEvidence([
        pendingResumeUpdate('retry_scheduled', 2),
        pendingResumeUpdate('recovered', 2),
      ])
    ).toEqual({
      pendingResumePhases: ['retry_scheduled', 'recovered'],
      pendingResumeAttempts: [2, 2],
      maxAttempts: 4,
    });
  });

  it.each([
    [
      'wrong attempt',
      [pendingResumeUpdate('retry_scheduled', 1), pendingResumeUpdate('recovered', 2)],
    ],
    [
      'terminal failed phase',
      [pendingResumeUpdate('retry_scheduled', 2), pendingResumeUpdate('failed', 2)],
    ],
    [
      'terminal exhausted phase',
      [pendingResumeUpdate('retry_scheduled', 2), pendingResumeUpdate('exhausted', 2)],
    ],
  ])('rejects %s in pending-resume evidence', (_name, updates) => {
    expect(() => inspectAcpPendingResumeEvidence(updates)).toThrow(
      'pending resume evidence is invalid'
    );
  });

  it('parses only exact bounded success evidence', () => {
    expect(
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify(safeEvidence),
        'provider-secret'
      )
    ).toEqual(safeEvidence);

    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify({ ...safeEvidence, extra: true }),
        'provider-secret'
      )
    ).toThrow('evidence is invalid');
  });

  it.each([
    ['missing field', { ...safeEvidence, optionMatched: undefined }],
    ['wrong interaction count', { ...safeEvidence, interactionResponded: 2 }],
    ['wrong recovery result count', { ...safeEvidence, recoveryToolResults: 0 }],
    ['wrong Write count', { ...safeEvidence, writeCalls: 2 }],
    ['wrong final count', { ...safeEvidence, acpFinalMarkerCount: 0 }],
    ['fallback used', { ...safeEvidence, termFallbackUsed: true }],
  ])('rejects %s', (_name, evidence) => {
    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify(evidence),
        'provider-secret'
      )
    ).toThrow('evidence is invalid');
  });

  it('rejects oversized evidence', () => {
    const serialized = JSON.stringify({
      ...safeEvidence,
      sessionId: 'x'.repeat(17_000),
    });

    expect(() =>
      parseDurableInteractionRecoveryAcpEvidence(serialized, 'provider-secret')
    ).toThrow('exceeded its serialized budget');
  });

  it('rejects secret-bearing evidence without echoing the secret', () => {
    const secret = 'provider-secret-material';
    let error: unknown;
    try {
      parseDurableInteractionRecoveryAcpEvidence(
        JSON.stringify({ ...safeEvidence, sessionId: secret }),
        secret
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('contains provider credentials');
    expect((error as Error).message).not.toContain(secret);
  });

  it('credential-gates final evidence after secrets arrive in split chunks', () => {
    const secret = 'provider-secret-material';
    const serialized = serializeDurableInteractionRecoveryAcpEvidence(
      { ...safeEvidence, modeId: secret },
      secret,
      ['provider-secret-', 'material']
    );

    expect(JSON.parse(serialized)).toEqual({
      success: false,
      stage: 'evidence',
      code: 'surface_secret',
      reason: 'none',
      timedOut: false,
      secretSeen: true,
      termFallbackUsed: false,
      killFallbackUsed: false,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized.trim().split(/\r?\n/)).toHaveLength(1);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16 * 1024);
  });

  it.each(['inbox_acknowledged', 'turn_completed'] as const)(
    'fails closed on duplicate recovered %s evidence',
    (type) => {
      const events = completionLifecycleEvents();
      const duplicate = events.find((event) => event.type === type);
      expect(duplicate).toBeDefined();

      expect(() =>
        inspectDurableCompletionLifecycle(
          [...events, { ...duplicate!, id: `duplicate-${type}` }],
          'interaction-request-1'
        )
      ).toThrow('duplicate durable completion evidence');
    }
  );

  it('accepts a failed recovered attempt followed by one completed retry', () => {
    expect(
      inspectDurableCompletionLifecycle(
        retryCompletionLifecycleEvents(),
        'interaction-request-1'
      )
    ).toMatchObject({ turnId: 'recovered-turn-attempt-2' });
  });

  it('returns incomplete while the final recovered attempt is still active', () => {
    expect(
      inspectDurableCompletionLifecycle(
        retryCompletionLifecycleEvents().slice(0, 3),
        'interaction-request-1'
      )
    ).toBeUndefined();
  });

  it('fails closed when two recovered attempts both complete', () => {
    const events = retryCompletionLifecycleEvents();
    const firstCompletion: Extract<SessionEvent, { type: 'turn_completed' }> = {
      ...eventBase('turn-completed-attempt-1', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId: 'recovered-turn-attempt-1',
        completedAt: '2026-08-29T00:00:01.000Z',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1_000,
      },
    };

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[0]!, firstCompletion, ...events.slice(2)],
        'interaction-request-1'
      )
    ).toThrow('duplicate durable completion evidence');
  });

  it('fails closed when a prior recovered attempt has no terminal', () => {
    const events = retryCompletionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[0]!, ...events.slice(2)],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('fails closed when acknowledgement belongs before the final attempt', () => {
    const events = retryCompletionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[0]!, events[3]!, events[1]!, events[2]!, events[4]!],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('fails closed when a failed prior attempt acknowledges the recovered inbox', () => {
    const events = retryCompletionLifecycleEvents();
    const priorAbort = events[1]!;
    if (priorAbort.type !== 'turn_aborted') throw new Error('Expected abort fixture');

    expect(() =>
      inspectDurableCompletionLifecycle(
        [
          events[0]!,
          {
            ...priorAbort,
            data: {
              ...priorAbort.data,
              acknowledgedInputMessageIds: ['interaction-request-1'],
            },
          },
          ...events.slice(2),
        ],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('fails closed when a prior abort uses legacy recovery evidence', () => {
    const events = retryCompletionLifecycleEvents();
    const priorAbort = events[1]!;
    if (priorAbort.type !== 'turn_aborted') throw new Error('Expected abort fixture');

    expect(() =>
      inspectDurableCompletionLifecycle(
        [
          events[0]!,
          {
            ...priorAbort,
            data: {
              ...priorAbort.data,
              recovery: {
                version: 1,
                inputMessageIds: ['interaction-request-1'],
                hadSuccessfulToolResult: false,
                emptyFinalCorrectionSpent: false,
              },
            },
          },
          ...events.slice(2),
        ],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('fails closed when one recovered attempt has duplicate terminal events', () => {
    const events = retryCompletionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        [
          ...events.slice(0, 2),
          { ...events[1]!, id: 'duplicate-abort' },
          ...events.slice(2),
        ],
        'interaction-request-1'
      )
    ).toThrow('duplicate durable completion evidence');
  });

  it('fails closed when the inbox is claimed again after completion', () => {
    const events = retryCompletionLifecycleEvents();
    const laterStart: Extract<SessionEvent, { type: 'turn_started' }> = {
      ...eventBase('turn-started-attempt-3', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId: 'recovered-turn-attempt-3',
        kind: 'pending',
        startedAt: '2026-08-29T00:00:05.000Z',
        inputMessageIds: ['interaction-request-1'],
      },
    };

    expect(() =>
      inspectDurableCompletionLifecycle(
        [...events, laterStart],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('fails closed when a recovered turn id is started more than once', () => {
    const events = retryCompletionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[0]!, { ...events[0]!, id: 'duplicate-turn-started' }],
        'interaction-request-1'
      )
    ).toThrow('duplicate durable completion evidence');
  });

  it('requires recovered turn start, acknowledgement, and completion in order', () => {
    const events = completionLifecycleEvents();
    expect(
      inspectDurableCompletionLifecycle(events, 'interaction-request-1')
    ).toMatchObject({ turnId: 'recovered-turn' });

    expect(() =>
      inspectDurableCompletionLifecycle(
        [events[1]!, events[0]!, events[2]!],
        'interaction-request-1'
      )
    ).toThrow('durable completion ordering is invalid');
  });

  it('propagates durable I/O failures immediately instead of timing out', async () => {
    const eio = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    const startedAt = Date.now();

    await expect(
      pollDurableInteractionCompletion({
        deadlineAt: Date.now() + 5_000,
        inspect: async () => {
          throw eio;
        },
        intervalMs: 1,
      })
    ).rejects.toBe(eio);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('fails closed when the durable event count or byte budget is exceeded', () => {
    const events = completionLifecycleEvents();

    expect(() =>
      inspectDurableCompletionLifecycle(
        Array.from({ length: 4_097 }, (_, index) => ({
          ...events[0]!,
          id: `event-${index}`,
        })),
        'interaction-request-1'
      )
    ).toThrow('durable event budget exceeded');

    expect(() =>
      inspectDurableCompletionLifecycle(
        [{ ...events[0]!, id: 'x'.repeat(2 * 1024 * 1024) }],
        'interaction-request-1'
      )
    ).toThrow('durable event budget exceeded');
  });

  it('rejects an extra failed Write result beside the successful result', () => {
    const writeCallId = 'write-call';
    const part = (
      id: string,
      partType: 'tool_call' | 'tool_result',
      payload: Record<string, unknown>
    ): Extract<SessionEvent, { type: 'part_created' }> => ({
      ...eventBase(id, 'part_created'),
      type: 'part_created',
      data: {
        partId: id,
        messageId: `${id}-message`,
        partType,
        payload: { toolCallId: writeCallId, toolName: 'Write', ...payload },
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    });
    const events = [
      part('write-call', 'tool_call', {
        input: {
          file_path: '/tmp/blade/workspace/channel.txt',
          content: 'Stable\n',
        },
      }),
      part('write-success', 'tool_result', { output: 'written', error: null }),
      part('write-failure', 'tool_result', { output: null, error: 'failed' }),
    ];

    expect(() =>
      inspectDurableWriteEvidence(
        events,
        '/tmp/blade/workspace/channel.txt',
        'Stable\n'
      )
    ).toThrow('duplicate recovery side effect');
  });

  it.each([
    [
      'wrong toolCallId',
      { toolCallId: 'other-question-call', output: 'recovered', error: null },
    ],
    [
      'failed result',
      { toolCallId: 'question-call', output: null, error: 'recovery failed' },
    ],
  ])('rejects a recovery result with %s', (_name, result) => {
    const event: Extract<SessionEvent, { type: 'part_created' }> = {
      ...eventBase('recovery-result', 'part_created'),
      type: 'part_created',
      data: {
        partId: 'recovery-result',
        messageId: 'recovery-message',
        partType: 'tool_result',
        payload: {
          toolName: 'AskUserQuestion',
          ...result,
          metadata: {
            interactionRecovery: true,
            requestId: 'request-1',
          },
        },
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    };

    expect(() =>
      inspectDurableRecoveryResult([event], 'request-1', 'question-call')
    ).toThrow('recovery result evidence is invalid');
  });

  it('binds the final marker to the recovered completed turn', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const validEvents = [
      base[0]!,
      base[1]!,
      ...finalMessageEvents('recovered-turn', marker),
      base[2]!,
      completionStatusEvent('recovered-completed-status'),
    ];
    const validLifecycle = inspectDurableCompletionLifecycle(
      validEvents,
      'interaction-request-1'
    );
    expect(validLifecycle).toBeDefined();
    expect(
      inspectDurableFinalMarker(validEvents, validLifecycle!.completed, marker)
    ).toBe(1);

    const laterTurn: SessionEvent[] = [
      {
        ...eventBase('later-turn-start', 'turn_started'),
        type: 'turn_started',
        data: {
          turnId: 'later-turn',
          kind: 'user',
          startedAt: '2026-08-29T00:00:03.000Z',
        },
      },
      ...finalMessageEvents('later-turn', marker),
      {
        ...eventBase('later-turn-completed', 'turn_completed'),
        type: 'turn_completed',
        data: {
          turnId: 'later-turn',
          completedAt: '2026-08-29T00:00:04.000Z',
          turnsCount: 1,
          toolCallsCount: 0,
          durationMs: 1_000,
        },
      },
      completionStatusEvent('later-completed-status'),
    ];
    const misleadingEvents = [...base, ...laterTurn];
    const recoveredLifecycle = inspectDurableCompletionLifecycle(
      misleadingEvents,
      'interaction-request-1'
    );
    expect(recoveredLifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(misleadingEvents, recoveredLifecycle!.completed, marker)
    ).toThrow('final marker does not belong to recovered turn');
  });

  it('waits for the recovered turn task status before judging its final marker', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const eventsBeforeTaskCompletion = [
      base[0]!,
      base[1]!,
      ...finalMessageEvents('recovered-turn', marker),
      base[2]!,
    ];
    const lifecycle = inspectDurableCompletionLifecycle(
      eventsBeforeTaskCompletion,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(
      inspectDurableFinalMarker(
        eventsBeforeTaskCompletion,
        lifecycle!.completed,
        marker
      )
    ).toBeUndefined();
    expect(
      inspectDurableFinalMarker(
        [
          ...eventsBeforeTaskCompletion,
          completionStatusEvent('recovered-completed-status'),
        ],
        lifecycle!.completed,
        marker
      )
    ).toBe(1);
  });

  it('fails closed on a malformed durable final before task status is written', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const malformedEvents = [base[0]!, base[1]!, base[2]!];
    const lifecycle = inspectDurableCompletionLifecycle(
      malformedEvents,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(malformedEvents, lifecycle!.completed, marker)
    ).toThrow('durable final structure is invalid');
  });

  it('fails closed on non-exact durable text before task status is written', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const events = [
      base[0]!,
      base[1]!,
      ...finalMessageEvents('recovered-turn', `${marker}!`),
      base[2]!,
    ];
    const lifecycle = inspectDurableCompletionLifecycle(
      events,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(events, lifecycle!.completed, marker)
    ).toThrow('durable final marker is not exact');
  });

  it('fails closed on a duplicate durable marker before task status is written', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const events = [
      base[0]!,
      base[1]!,
      ...finalMessageEvents('earlier-turn', marker),
      ...finalMessageEvents('recovered-turn', marker),
      base[2]!,
    ];
    const lifecycle = inspectDurableCompletionLifecycle(
      events,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(events, lifecycle!.completed, marker)
    ).toThrow('durable final marker count is invalid');
  });

  it('fails with a fixed reason when the durable final assistant text is not exact', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const validEvents = [
      base[0]!,
      base[1]!,
      ...finalMessageEvents('recovered-turn', `${marker}!`),
      base[2]!,
      completionStatusEvent('recovered-completed-status'),
    ];
    const lifecycle = inspectDurableCompletionLifecycle(
      validEvents,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(validEvents, lifecycle!.completed, marker)
    ).toThrow('durable final marker is not exact');
  });

  it('fails with a fixed reason when the durable final marker count is not exactly one', () => {
    const marker = 'ACP_DURABLE_COMPLETE';
    const base = completionLifecycleEvents();
    const earlierMarker = finalMessageEvents('earlier-turn', marker);
    const validEvents = [
      base[0]!,
      base[1]!,
      ...earlierMarker,
      ...finalMessageEvents('recovered-turn', marker),
      base[2]!,
      completionStatusEvent('recovered-completed-status'),
    ];
    const lifecycle = inspectDurableCompletionLifecycle(
      validEvents,
      'interaction-request-1'
    );

    expect(lifecycle).toBeDefined();
    expect(() =>
      inspectDurableFinalMarker(validEvents, lifecycle!.completed, marker)
    ).toThrow('durable final marker count is invalid');
  });

  it('fails with a fixed reason when the ACP final marker count is not exactly one', () => {
    expect(() =>
      inspectAcpFinalMarker(
        'ACP_DURABLE_COMPLETE ACP_DURABLE_COMPLETE',
        'ACP_DURABLE_COMPLETE',
        false
      )
    ).toThrow('ACP final marker count is invalid');
  });

  it('fails with a fixed reason when the ACP surface text overflowed', () => {
    expect(() =>
      inspectAcpFinalMarker('ACP_DURABLE_COMPLETE', 'ACP_DURABLE_COMPLETE', true)
    ).toThrow('ACP surface text overflowed');
  });

  it('drains stderr before accepting child shutdown and sees a tail secret', async () => {
    const stderr = new PassThrough();
    const scanner = new SecretScanner('provider-secret-material');
    const stderrDrained = drainChildStderr(stderr, scanner);
    const shutdown = awaitAcpChildShutdown(
      Promise.resolve({ code: 0, signal: null }),
      Promise.resolve(),
      stderrDrained,
      scanner,
      1_000
    );
    let settled = false;
    void shutdown.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    stderr.write('provider-secret-');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    stderr.end('material');

    await expect(shutdown).rejects.toThrow('surface secret');
    expect(scanner.seen).toBe(true);

    await expect(
      awaitAcpChildShutdown(
        Promise.resolve({ code: 0, signal: null }),
        Promise.resolve(),
        drainChildStderr(undefined, new SecretScanner('unused')),
        new SecretScanner('unused'),
        1_000
      )
    ).resolves.toEqual({ code: 0, signal: null });
  });

  it('restores BLADE_STORAGE_ROOT after success and failure', async () => {
    const original = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = '/tmp/original-storage';
    try {
      await expect(
        withDurableInteractionStorageRoot('/tmp/scoped-storage', async () => {
          expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/scoped-storage');
          return 'ok';
        })
      ).resolves.toBe('ok');
      expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/original-storage');

      await expect(
        withDurableInteractionStorageRoot('/tmp/scoped-storage', async () => {
          expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/scoped-storage');
          throw new Error('expected failure');
        })
      ).rejects.toThrow('expected failure');
      expect(process.env.BLADE_STORAGE_ROOT).toBe('/tmp/original-storage');
    } finally {
      if (original === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = original;
    }
  });

  it('accepts numeric timeoutMs separately from string settings', () => {
    expect(parseDurableInteractionRecoveryAcpRunnerInput(encodedInput())).toMatchObject(
      {
        timeoutMs: 270_000,
        answerLabel: 'Stable',
        nodeExecutable: '/opt/homebrew/bin/node',
      }
    );
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ timeoutMs: '270000' })
      )
    ).toThrow('input is invalid');
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ requestId: undefined })
      )
    ).toThrow('input is invalid');
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ nodeExecutable: '/opt/homebrew/bin/bun' })
      )
    ).toThrow('input is invalid');
    expect(() =>
      parseDurableInteractionRecoveryAcpRunnerInput(
        encodedInput({ nodeExecutable: 'node' })
      )
    ).toThrow('input is invalid');
  });

  it('uses the production CLI SDK stdio lifecycle without an extra prompt', async () => {
    const runnerPath = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryAcpRunner.ts'
    );
    const source = await readFile(runnerPath, 'utf8');

    expect(source).toContain("'/dist/blade.js'");
    expect(source).toContain("spawn(input.nodeExecutable, [input.cliEntry, '--acp']");
    expect(source).not.toContain("spawn(process.execPath, [input.cliEntry, '--acp']");
    expect(source).toContain('new acp.ClientSideConnection');
    expect(source).toContain('acp.ndJsonStream(');
    expect(source).toContain('Writable.toWeb(child.stdin)');
    expect(source).toContain('Readable.toWeb(stdout)');
    expect(source).toContain('connection.loadSession({');
    expect(source).not.toContain('connection.prompt(');
    expect(source).not.toContain('new BladeAgent(');
    expect(source).not.toContain('createMockACPClient');
    expect(source).toContain('connection.closeSession({');
    expect(source).toContain('drainChildStderr(child.stderr');
    expect(source).toContain('awaitAcpChildShutdown(');
    expect(source).toContain('await endChildInput(child);');
    expect(source.indexOf('connection.closeSession({')).toBeLessThan(
      source.indexOf('await endChildInput(child);')
    );
    const endChildInput = source.slice(
      source.indexOf('function endChildInput('),
      source.indexOf('async function main()')
    );
    expect(endChildInput).toContain('stdin.end(');
    expect(source.match(/process\.stdout\.write\(/g)).toHaveLength(1);
  });

  it('emits one bounded JSON failure record for invalid input', async () => {
    const runnerPath = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryAcpRunner.ts'
    );
    const secret = 'invalid-input-secret';
    let stdout = '';
    let stderr = '';
    try {
      await execFileAsync('bun', [runnerPath], {
        env: {
          ...process.env,
          BLADE_DURABLE_INTERACTION_ACP_INPUT: Buffer.from(secret).toString('base64'),
        },
        timeout: 10_000,
        maxBuffer: 32 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }

    expect(JSON.parse(stdout)).toEqual({
      success: false,
      stage: 'input',
      code: 'invalid_input',
      reason: 'none',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
    });
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(`${stdout}\n${stderr}`).not.toContain(secret);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024);
  });
});
