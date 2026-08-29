import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  createDurableInteractionRecoveryPtyFinalInstruction,
  inspectDurableInteractionPtyRetryLifecycle,
  parseDurableInteractionRecoveryPtyEvidence,
  parseDurableInteractionRecoveryPtyFailureEvidence,
  pollDurableInteractionPtyCompletion,
} from '../../support/durableInteractionRecoveryPtyDriver.js';
import { createSplitPtyMarkerInstruction } from '../../support/foregroundBoundedOutputPtyDriver.js';

vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);

const expectedContent = 'Canary\n';
const expectedSha256 =
  '7a29a06b7f0ece46a22639b9b3d5adef0779cd2fd162ec92d6dbaf80fd484938';

const safeEvidence = {
  success: true,
  sessionId: 'durable-interaction-session',
  questionVisible: true,
  canaryVisible: true,
  reviewVisible: true,
  finalMarkerSeen: true,
  secretSeen: false,
  interactionRequested: 1,
  interactionResponded: 1,
  interactionRecovered: 1,
  pendingAttempts: 2,
  failedAttempts: 1,
  completedAttempts: 1,
  acknowledgements: 1,
  firstFailureReplaySafe: true,
  writeCalls: 1,
  writeResults: 1,
  inboxMissing: true,
  targetSha256: expectedSha256,
  exitCode: 0,
  exitSignal: null,
  termFallbackUsed: false,
  killFallbackUsed: false,
  output: 'Durable question visible\nFinal marker rendered',
} as const;

type RetryLifecycleInspector = (
  events: readonly SessionEvent[],
  inboxMessageId: string
) =>
  | {
      firstAttempt: { turnId: string };
      completedAttempt: { turnId: string };
    }
  | undefined;

function retryLifecycleInspector(): RetryLifecycleInspector {
  const candidate: unknown = inspectDurableInteractionPtyRetryLifecycle;
  expect(candidate).toBeTypeOf('function');
  if (typeof candidate !== 'function') {
    throw new Error('Durable interaction PTY retry lifecycle inspector is unavailable');
  }
  return candidate as RetryLifecycleInspector;
}

type CompletionPoller = <T>(input: {
  deadlineAt: number;
  inspect: () => Promise<T | undefined>;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  intervalMs?: number;
}) => Promise<T>;

function completionPoller(): CompletionPoller {
  const candidate: unknown = pollDurableInteractionPtyCompletion;
  expect(candidate).toBeTypeOf('function');
  if (typeof candidate !== 'function') {
    throw new Error('Durable interaction PTY completion poller is unavailable');
  }
  return candidate as CompletionPoller;
}

function eventBase(id: string, type: SessionEvent['type']) {
  return {
    id,
    sessionId: 'durable-interaction-session',
    timestamp: '2026-08-30T00:00:00.000Z',
    type,
    cwd: '/tmp/blade/workspace',
    version: 'test',
  };
}

function retryLifecycleEvents(): SessionEvent[] {
  const inboxMessageId = 'interaction-request-1';
  return [
    {
      ...eventBase('turn-started-attempt-1', 'turn_started'),
      type: 'turn_started',
      data: {
        turnId: 'recovered-turn-attempt-1',
        kind: 'pending',
        startedAt: '2026-08-30T00:00:00.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('turn-aborted-attempt-1', 'turn_aborted'),
      type: 'turn_aborted',
      data: {
        turnId: 'recovered-turn-attempt-1',
        cause: 'failed',
        abortedAt: '2026-08-30T00:00:01.000Z',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1_000,
        recovery: {
          version: 3,
          inputMessageIds: [inboxMessageId],
          hadSuccessfulToolResult: false,
          interruptedToolCallCount: 0,
          allSuccessfulToolResultsSafeForResume: false,
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
        startedAt: '2026-08-30T00:00:02.000Z',
        inputMessageIds: [inboxMessageId],
      },
    },
    {
      ...eventBase('inbox-acknowledged-attempt-2', 'inbox_acknowledged'),
      type: 'inbox_acknowledged',
      data: {
        messageIds: [inboxMessageId],
        acknowledgedAt: '2026-08-30T00:00:03.000Z',
      },
    },
    {
      ...eventBase('turn-completed-attempt-2', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId: 'recovered-turn-attempt-2',
        completedAt: '2026-08-30T00:00:04.000Z',
        turnsCount: 1,
        toolCallsCount: 1,
        durationMs: 2_000,
      },
    },
  ];
}

describe('durable interaction raw PTY driver', () => {
  it('accepts exact bounded evidence', () => {
    expect(
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(safeEvidence),
        'credential-token',
        expectedContent
      )
    ).toEqual(safeEvidence);
  });

  it.each([
    ['missing flag', { ...safeEvidence, reviewVisible: undefined }],
    ['wrong interaction count', { ...safeEvidence, interactionRecovered: 2 }],
    ['wrong attempt count', { ...safeEvidence, pendingAttempts: 1 }],
    ['wrong failed count', { ...safeEvidence, failedAttempts: 0 }],
    ['wrong completed count', { ...safeEvidence, completedAttempts: 0 }],
    ['wrong acknowledgement count', { ...safeEvidence, acknowledgements: 0 }],
    ['missing safe failure proof', { ...safeEvidence, firstFailureReplaySafe: false }],
    ['wrong Write count', { ...safeEvidence, writeCalls: 2 }],
    ['wrong Write result count', { ...safeEvidence, writeResults: 0 }],
  ])('rejects %s', (_name, evidence) => {
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(evidence),
        'credential-token',
        expectedContent
      )
    ).toThrow('evidence is incomplete');
  });

  it('accepts exactly one replay-safe failed attempt followed by one completion', () => {
    expect(
      retryLifecycleInspector()(retryLifecycleEvents(), 'interaction-request-1')
    ).toMatchObject({
      firstAttempt: { turnId: 'recovered-turn-attempt-1' },
      completedAttempt: { turnId: 'recovered-turn-attempt-2' },
    });
  });

  it.each([
    ['before any attempt', 0],
    ['while the first attempt is active', 1],
    ['after the replay-safe first abort', 2],
    ['while the retry is active', 3],
    ['after acknowledgement but before completion', 4],
  ])('waits %s', (_name, length) => {
    expect(
      retryLifecycleInspector()(
        retryLifecycleEvents().slice(0, length),
        'interaction-request-1'
      )
    ).toBeUndefined();
  });

  it('fails closed when the first attempt reports tool activity', () => {
    const events = retryLifecycleEvents();
    const abort = events[1]!;
    if (abort.type !== 'turn_aborted') throw new Error('Expected abort fixture');

    expect(() =>
      retryLifecycleInspector()(
        [
          events[0]!,
          { ...abort, data: { ...abort.data, toolCallsCount: 1 } },
          ...events.slice(2),
        ],
        'interaction-request-1'
      )
    ).toThrow('replay-safe');
  });

  it('fails closed when observable output is persisted before the first abort', () => {
    const events = retryLifecycleEvents();
    const firstStart = events[0]!;
    if (firstStart.type !== 'turn_started') throw new Error('Expected start fixture');
    const outputMessageId = 'first-attempt-output';
    const outputEvents: SessionEvent[] = [
      {
        ...eventBase('first-attempt-message', 'message_created'),
        type: 'message_created',
        data: {
          messageId: outputMessageId,
          role: 'assistant',
          createdAt: '2026-08-30T00:00:00.500Z',
          metadata: {
            turnFinalization: {
              turnId: firstStart.data.turnId,
              inputMessageIds: ['interaction-request-1'],
              turnsCount: 1,
              toolCallsCount: 0,
              durationMs: 500,
            },
          },
        },
      },
      {
        ...eventBase('first-attempt-part', 'part_created'),
        type: 'part_created',
        data: {
          partId: 'first-attempt-part',
          messageId: outputMessageId,
          partType: 'text',
          payload: { text: 'observable' },
          createdAt: '2026-08-30T00:00:00.500Z',
        },
      },
    ];

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, ...outputEvents, ...events.slice(1)],
        'interaction-request-1'
      )
    ).toThrow('replay-safe');
  });

  it('fails closed when an updated tool part appears before the first abort', () => {
    const events = retryLifecycleEvents();
    const toolUpdate: SessionEvent = {
      ...eventBase('first-attempt-tool-update', 'part_updated'),
      type: 'part_updated',
      data: {
        partId: 'first-attempt-tool',
        messageId: 'first-attempt-assistant',
        partType: 'tool_call',
        payload: {
          toolName: 'Write',
          toolCallId: 'unsafe-write',
          input: { file_path: '/tmp/unsafe', content: 'unsafe' },
        },
        createdAt: '2026-08-30T00:00:00.500Z',
      },
    };

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, toolUpdate, ...events.slice(1)],
        'interaction-request-1'
      )
    ).toThrow('replay-safe');
  });

  it.each([
    [
      'a cancellation',
      (abort: Extract<SessionEvent, { type: 'turn_aborted' }>) => ({
        ...abort,
        data: { ...abort.data, cause: 'cancelled' as const },
      }),
    ],
    [
      'a successful tool result',
      (abort: Extract<SessionEvent, { type: 'turn_aborted' }>) => ({
        ...abort,
        data: {
          ...abort.data,
          recovery: abort.data.recovery
            ? { ...abort.data.recovery, hadSuccessfulToolResult: true }
            : undefined,
        },
      }),
    ],
    [
      'an interrupted tool',
      (abort: Extract<SessionEvent, { type: 'turn_aborted' }>) => ({
        ...abort,
        data: {
          ...abort.data,
          recovery:
            abort.data.recovery?.version === 2 || abort.data.recovery?.version === 3
              ? { ...abort.data.recovery, interruptedToolCallCount: 1 }
              : abort.data.recovery,
        },
      }),
    ],
    [
      'a mismatched inbox',
      (abort: Extract<SessionEvent, { type: 'turn_aborted' }>) => ({
        ...abort,
        data: {
          ...abort.data,
          recovery: abort.data.recovery
            ? { ...abort.data.recovery, inputMessageIds: ['different-inbox'] }
            : undefined,
        },
      }),
    ],
  ])('fails closed when the first abort records %s', (_name, mutate) => {
    const events = retryLifecycleEvents();
    const abort = events[1]!;
    if (abort.type !== 'turn_aborted') throw new Error('Expected abort fixture');

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, mutate(abort), ...events.slice(2)],
        'interaction-request-1'
      )
    ).toThrow('replay-safe');
  });

  it('fails closed when one turn has both aborted and completed terminals', () => {
    const events = retryLifecycleEvents();
    const firstStart = events[0]!;
    if (firstStart.type !== 'turn_started') throw new Error('Expected start fixture');
    const duplicateCompletion: SessionEvent = {
      ...eventBase('first-attempt-completed-too', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId: firstStart.data.turnId,
        completedAt: '2026-08-30T00:00:01.500Z',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 1_500,
      },
    };

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, events[1]!, duplicateCompletion, ...events.slice(2)],
        'interaction-request-1'
      )
    ).toThrow('unexpected terminal');
  });

  it('fails closed when an unrelated turn adds another completion', () => {
    const events = retryLifecycleEvents();
    const unrelatedCompletion: SessionEvent = {
      ...eventBase('unrelated-turn-completed', 'turn_completed'),
      type: 'turn_completed',
      data: {
        turnId: 'unrelated-turn',
        completedAt: '2026-08-30T00:00:05.000Z',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 100,
      },
    };

    expect(() =>
      retryLifecycleInspector()(
        [...events, unrelatedCompletion],
        'interaction-request-1'
      )
    ).toThrow('unexpected terminal');
  });

  it('fails closed when acknowledgement precedes the retry attempt', () => {
    const events = retryLifecycleEvents();

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, events[1]!, events[3]!, events[2]!, events[4]!],
        'interaction-request-1'
      )
    ).toThrow('in order');
  });

  it('fails closed when a third recovered attempt claims the inbox', () => {
    const events = retryLifecycleEvents();
    const secondStart = events[2]!;
    if (secondStart.type !== 'turn_started') throw new Error('Expected start fixture');

    expect(() =>
      retryLifecycleInspector()(
        [
          ...events,
          {
            ...secondStart,
            id: 'turn-started-attempt-3',
            data: { ...secondStart.data, turnId: 'recovered-turn-attempt-3' },
          },
        ],
        'interaction-request-1'
      )
    ).toThrow('exactly two');
  });

  it('fails closed when the retry starts before the first attempt aborts', () => {
    const events = retryLifecycleEvents();

    expect(() =>
      retryLifecycleInspector()(
        [events[0]!, ...events.slice(2)],
        'interaction-request-1'
      )
    ).toThrow('before aborting');
  });

  it('fails closed on a duplicate acknowledgement', () => {
    const events = retryLifecycleEvents();
    const acknowledgement = events[3]!;
    if (acknowledgement.type !== 'inbox_acknowledged') {
      throw new Error('Expected acknowledgement fixture');
    }

    expect(() =>
      retryLifecycleInspector()(
        [
          ...events.slice(0, 4),
          { ...acknowledgement, id: 'duplicate-acknowledgement' },
          events[4]!,
        ],
        'interaction-request-1'
      )
    ).toThrow('duplicate acknowledgements');
  });

  it('fails immediately when durable completion inspection throws', async () => {
    let inspectCalls = 0;
    let waitCalls = 0;

    await expect(
      completionPoller()<string>({
        deadlineAt: 1_000,
        now: () => 0,
        inspect: async () => {
          inspectCalls++;
          throw new Error('durable evidence read failed');
        },
        wait: async () => {
          waitCalls++;
        },
      })
    ).rejects.toThrow('durable evidence read failed');
    expect(inspectCalls).toBe(1);
    expect(waitCalls).toBe(0);
  });

  it('polls only incomplete durable completion evidence', async () => {
    let now = 0;
    let inspectCalls = 0;
    let waitCalls = 0;

    await expect(
      completionPoller()<string>({
        deadlineAt: 1_000,
        now: () => now,
        inspect: async () => {
          inspectCalls++;
          return inspectCalls === 2 ? 'complete' : undefined;
        },
        wait: async (delayMs) => {
          waitCalls++;
          now += delayMs;
        },
        intervalMs: 50,
      })
    ).resolves.toBe('complete');
    expect(inspectCalls).toBe(2);
    expect(waitCalls).toBe(1);
  });

  it('rejects oversized evidence', () => {
    const serialized = JSON.stringify({ ...safeEvidence, output: 'x'.repeat(33_000) });

    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        serialized,
        'credential-token',
        expectedContent
      )
    ).toThrow('exceeded its serialized budget');
  });

  it.each([
    ['stdout', { ...safeEvidence, extra: 'provider-secret' }],
    ['output', { ...safeEvidence, output: 'provider-secret' }],
  ])('rejects a secret in %s without echoing it', (_name, evidence) => {
    let error: unknown;
    try {
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify(evidence),
        'provider-secret',
        expectedContent
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('contains provider credentials');
    expect((error as Error).message).not.toContain('provider-secret');
  });

  it('rejects unknown keys and a digest unrelated to expected content', () => {
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, unexpected: true }),
        'credential-token',
        expectedContent
      )
    ).toThrow('evidence is incomplete');
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, targetSha256: 'a'.repeat(64) }),
        'credential-token',
        expectedContent
      )
    ).toThrow('target digest mismatch');
    expect(() =>
      parseDurableInteractionRecoveryPtyEvidence(
        JSON.stringify({ ...safeEvidence, targetSha256: expectedSha256 }),
        'credential-token',
        expectedContent
      )
    ).not.toThrow();
  });

  it('rejects noncanonical shutdown evidence', () => {
    for (const evidence of [
      { ...safeEvidence, exitCode: 1 },
      { ...safeEvidence, exitSignal: 'SIGTERM' },
      { ...safeEvidence, termFallbackUsed: true },
      { ...safeEvidence, killFallbackUsed: true },
    ]) {
      expect(() =>
        parseDurableInteractionRecoveryPtyEvidence(
          JSON.stringify(evidence),
          'credential-token',
          expectedContent
        )
      ).toThrow('evidence is incomplete');
    }
  });

  it('accepts only bounded structural failure diagnostics', () => {
    const failure = {
      success: false,
      stage: 'completion',
      code: 'qualification_failed',
      reason: 'duplicate_interaction',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: true,
      killFallbackUsed: false,
      snapshot: {
        interactionRequested: 2,
        interactionResponded: 1,
        interactionRecovered: 1,
        recoveryToolResults: 1,
        writeCalls: 1,
        writeResults: 1,
        successfulWriteResults: 1,
        turnStarts: 1,
        acknowledgements: 1,
        turnCompleted: 1,
        turnAborted: 0,
        targetState: 'matched',
        inboxMissing: true,
        durableFinalState: 'matched',
        surfaceFinalSeen: true,
        questionVisible: true,
        reviewVisible: true,
        childExitState: 'running',
      },
    } as const;

    expect(
      parseDurableInteractionRecoveryPtyFailureEvidence(JSON.stringify(failure))
    ).toEqual(failure);
    expect(() =>
      parseDurableInteractionRecoveryPtyFailureEvidence(
        JSON.stringify({ ...failure, rawError: 'private' })
      )
    ).toThrow('safe failure evidence is invalid');
    expect(() =>
      parseDurableInteractionRecoveryPtyFailureEvidence(
        JSON.stringify({ ...failure, reason: 'provider-secret' })
      )
    ).toThrow('safe failure evidence is invalid');
  });

  it('builds a split final-marker instruction without embedding the marker', () => {
    const marker = 'DURABLE_PTY_FINAL_123456';
    const instruction = createDurableInteractionRecoveryPtyFinalInstruction(marker);

    expect(instruction).not.toContain(marker);
    expect(instruction).toContain('MARKER_TEMPLATE=');
    expect(instruction).toContain('Delete the one ~ character');
    expect(instruction).not.toBe(createSplitPtyMarkerInstruction(marker));
  });

  it('keeps the durable marker transform on the bounded ASCII contract', () => {
    for (const marker of ['', 'A', 'A'.repeat(129), 'HAS SPACE', 'UNICODE_你好']) {
      expect(() => createDurableInteractionRecoveryPtyFinalInstruction(marker)).toThrow(
        'bounded ASCII contract'
      );
    }
  });

  it('keeps the raw PTY production and keyboard synchronization contract', async () => {
    const supportRoot = path.resolve(import.meta.dirname, '../../support');
    const [driver, runner] = await Promise.all([
      readFile(
        path.join(supportRoot, 'durableInteractionRecoveryPtyDriver.ts'),
        'utf8'
      ),
      readFile(
        path.join(supportRoot, 'durableInteractionRecoveryPtyRunner.ts'),
        'utf8'
      ),
    ]);
    const source = driver + '\n' + runner;

    expect(source).toContain("from 'bun-pty'");
    expect(driver).toContain("'../../dist/blade.js'");
    expect(runner).toContain("'--resume'");
    expect(runner).toContain('input.sessionId');
    expect(runner).toContain("terminal.write('2')");
    expect(runner).toContain("terminal.write('y')");
    expect(runner.match(/terminal\.write\('\\u0004'\)/g)).toHaveLength(2);
    expect(runner).toContain('termFallbackUsed');
    expect(runner).toContain('killFallbackUsed');
    expect(runner).toContain('reviewOutputOffset = plainOutput.length');
    expect(runner).toContain('path.relative(input.workspace, input.target)');
    expect(runner).toContain('Non-canonical durable interaction PTY input encoding');
    const reviewOffset = runner.indexOf('reviewOutputOffset = plainOutput.length');
    const selectCanary = runner.indexOf("terminal.write('2')");
    const waitForReview = runner.indexOf('() => reviewVisible');
    const submitReview = runner.indexOf("terminal.write('y')");
    expect(reviewOffset).toBeGreaterThanOrEqual(0);
    expect(reviewOffset).toBeLessThan(selectCanary);
    expect(selectCanary).toBeLessThan(waitForReview);
    expect(waitForReview).toBeLessThan(submitReview);
    expect(source).not.toContain('agent.chat');
    expect(source).not.toContain('resolvePendingWithHandler');
    expect(driver).not.toContain("killSignal: 'SIGKILL'");
    expect(runner).not.toContain('output.replaceAll');
    expect(runner).not.toContain('error.message,');
    expect(runner).toContain("state: 'invalid'");
    expect(runner).toContain('lastCompletionSnapshot');
  });

  it('returns one structural failure JSON for invalid child input', async () => {
    const runner = path.resolve(
      import.meta.dirname,
      '../../support/durableInteractionRecoveryPtyRunner.ts'
    );
    let stdout = '';
    let stderr = '';
    try {
      await execFileAsync(process.env.BUN_EXEC_PATH ?? 'bun', [runner], {
        env: { ...process.env, BLADE_DURABLE_INTERACTION_PTY_INPUT: 'not-base64' },
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      stdout = String(failure.stdout ?? '');
      stderr = String(failure.stderr ?? '');
    }

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      success: false,
      stage: 'input',
      code: 'invalid_input',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
      reason: 'invalid_input',
      snapshot: null,
    });
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });
});
