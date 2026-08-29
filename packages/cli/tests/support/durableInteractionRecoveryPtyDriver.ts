import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SessionEvent } from '../../src/context/types.js';

const execFileAsync = promisify(execFile);
const MAX_SERIALIZED_EVIDENCE_BYTES = 32 * 1024;

function resolveBunExecutable(): string {
  const candidates = [
    process.env.BUN_EXEC_PATH,
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, 'bin', 'bun')
      : undefined,
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  const executable = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!executable) {
    throw new Error(
      'Bun executable is unavailable for the durable interaction PTY runner'
    );
  }
  return executable;
}

export interface DurableInteractionRecoveryPtyEvidence {
  success: true;
  sessionId: string;
  questionVisible: true;
  canaryVisible: true;
  reviewVisible: true;
  finalMarkerSeen: true;
  secretSeen: false;
  interactionRequested: 1;
  interactionResponded: 1;
  interactionRecovered: 1;
  pendingAttempts: 2;
  failedAttempts: 1;
  completedAttempts: 1;
  acknowledgements: 1;
  firstFailureReplaySafe: true;
  writeCalls: 1;
  writeResults: 1;
  inboxMissing: true;
  targetSha256: string;
  exitCode: 0;
  exitSignal: null;
  termFallbackUsed: false;
  killFallbackUsed: false;
  output: string;
}

export class InvalidDurableInteractionPtyLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: 'duplicate_turn' | 'invalid_order'
  ) {
    super(message);
  }
}

export interface DurableInteractionPtyRetryLifecycle {
  firstAttempt: { turnId: string; index: number };
  firstFailure: { turnId: string; index: number };
  completedAttempt: { turnId: string; index: number };
  acknowledgement: { index: number };
  completion: { turnId: string; index: number };
}

export async function pollDurableInteractionPtyCompletion<T>(input: {
  deadlineAt: number;
  inspect: () => Promise<T | undefined>;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  intervalMs?: number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const wait =
    input.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const intervalMs = input.intervalMs ?? 50;
  while (now() < input.deadlineAt) {
    const result = await input.inspect();
    if (result !== undefined) return result;
    await wait(intervalMs);
  }
  throw new Error(
    'Timed out waiting for durable interaction acknowledgement and completion'
  );
}

/**
 * Validate the exact durable lifecycle expected from the one-shot PTY fault test.
 * Incomplete prefixes return undefined so the runner can keep polling.
 */
export function inspectDurableInteractionPtyRetryLifecycle(
  events: readonly SessionEvent[],
  inboxMessageId: string
): DurableInteractionPtyRetryLifecycle | undefined {
  const terminalEvents = events.filter(
    (event) => event.type === 'turn_completed' || event.type === 'turn_aborted'
  );
  if (terminalEvents.length > 2) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains an unexpected terminal',
      'duplicate_turn'
    );
  }
  const starts = events.flatMap((event, index) => {
    if (event.type !== 'turn_started') return [];
    const claims =
      event.data.inputMessageIds?.filter((id) => id === inboxMessageId).length ?? 0;
    if (claims === 0) return [];
    if (
      claims !== 1 ||
      event.data.kind !== 'pending' ||
      event.data.inputMessageIds?.length !== 1
    ) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle must claim exactly one durable inbox message',
        'invalid_order'
      );
    }
    return [{ event, index }];
  });
  if (starts.length > 2) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle must contain exactly two pending attempts',
      'duplicate_turn'
    );
  }
  if (new Set(starts.map(({ event }) => event.data.turnId)).size !== starts.length) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains duplicate turn identities',
      'duplicate_turn'
    );
  }
  const claimedTurnIds = new Set(starts.map(({ event }) => event.data.turnId));
  if (terminalEvents.some((event) => !claimedTurnIds.has(event.data.turnId))) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains an unexpected terminal',
      'duplicate_turn'
    );
  }

  const acknowledgements = events.flatMap((event, index) => {
    if (event.type !== 'inbox_acknowledged') return [];
    const matches = event.data.messageIds.filter((id) => id === inboxMessageId).length;
    if (matches === 0) return [];
    if (matches !== 1 || event.data.messageIds.length !== 1) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle acknowledgement is not exact',
        'invalid_order'
      );
    }
    return [{ event, index }];
  });
  if (acknowledgements.length > 1) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains duplicate acknowledgements',
      'invalid_order'
    );
  }
  if (starts.length === 0) {
    if (acknowledgements.length > 0) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle acknowledges input before an attempt',
        'invalid_order'
      );
    }
    return undefined;
  }

  const terminalsFor = (turnId: string) =>
    events.flatMap((event, index) =>
      (event.type === 'turn_completed' || event.type === 'turn_aborted') &&
      event.data.turnId === turnId
        ? [{ event, index }]
        : []
    );
  const firstStart = starts[0]!;
  const firstTerminals = terminalsFor(firstStart.event.data.turnId);
  if (firstTerminals.length > 1) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains duplicate first-attempt terminals',
      'duplicate_turn'
    );
  }
  const firstTerminal = firstTerminals[0];
  if (!firstTerminal) {
    if (starts.length > 1 || acknowledgements.length > 0) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle started a successor before aborting the first attempt',
        'invalid_order'
      );
    }
    return undefined;
  }
  if (firstTerminal.index <= firstStart.index) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle terminal precedes its first attempt',
      'invalid_order'
    );
  }
  const firstFailure = firstTerminal.event;
  const recovery =
    firstFailure.type === 'turn_aborted' ? firstFailure.data.recovery : undefined;
  const assistantMessageIds = new Set(
    events.flatMap((event) =>
      event.type === 'message_created' && event.data.role === 'assistant'
        ? [event.data.messageId]
        : []
    )
  );
  const firstAttemptObservableEvents = events
    .slice(firstStart.index + 1, firstTerminal.index)
    .filter(
      (event) =>
        (event.type === 'message_created' && event.data.role === 'assistant') ||
        ((event.type === 'part_created' || event.type === 'part_updated') &&
          (assistantMessageIds.has(event.data.messageId) ||
            event.data.partType === 'tool_call' ||
            event.data.partType === 'tool_result'))
    );
  if (
    firstFailure.type !== 'turn_aborted' ||
    firstFailure.data.cause !== 'failed' ||
    firstFailure.data.toolCallsCount !== 0 ||
    (recovery?.version !== 2 && recovery?.version !== 3) ||
    recovery.inputMessageIds.length !== 1 ||
    recovery.inputMessageIds[0] !== inboxMessageId ||
    recovery.hadSuccessfulToolResult !== false ||
    recovery.interruptedToolCallCount !== 0 ||
    (recovery.version === 3 &&
      recovery.allSuccessfulToolResultsSafeForResume !== false) ||
    firstFailure.data.acknowledgedInputMessageIds?.includes(inboxMessageId) ||
    firstAttemptObservableEvents.length !== 0
  ) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry first failure is not replay-safe',
      'invalid_order'
    );
  }
  if (starts.length === 1) {
    if (acknowledgements.length > 0) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle acknowledged input before its retry',
        'invalid_order'
      );
    }
    return undefined;
  }

  const secondStart = starts[1]!;
  if (firstTerminal.index >= secondStart.index) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle starts its retry before the failed attempt terminates',
      'invalid_order'
    );
  }
  const secondTerminals = terminalsFor(secondStart.event.data.turnId);
  if (secondTerminals.length > 1) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle contains duplicate retry terminals',
      'duplicate_turn'
    );
  }
  const secondTerminal = secondTerminals[0];
  if (!secondTerminal) {
    const acknowledgement = acknowledgements[0];
    if (acknowledgement && acknowledgement.index <= secondStart.index) {
      throw new InvalidDurableInteractionPtyLifecycleError(
        'PTY retry lifecycle acknowledgement precedes its retry',
        'invalid_order'
      );
    }
    return undefined;
  }
  const acknowledgement = acknowledgements[0];
  if (
    secondTerminal.event.type !== 'turn_completed' ||
    !acknowledgement ||
    !(
      secondStart.index < acknowledgement.index &&
      acknowledgement.index < secondTerminal.index
    )
  ) {
    throw new InvalidDurableInteractionPtyLifecycleError(
      'PTY retry lifecycle does not complete its second attempt in order',
      'invalid_order'
    );
  }

  return {
    firstAttempt: { turnId: firstStart.event.data.turnId, index: firstStart.index },
    firstFailure: { turnId: firstFailure.data.turnId, index: firstTerminal.index },
    completedAttempt: {
      turnId: secondStart.event.data.turnId,
      index: secondStart.index,
    },
    acknowledgement: { index: acknowledgement.index },
    completion: {
      turnId: secondTerminal.event.data.turnId,
      index: secondTerminal.index,
    },
  };
}

export interface DurableInteractionRecoveryPtyInput {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  requestId: string;
  target: string;
  expectedContent: string;
  finalMarker: string;
  secret: string;
  timeoutMs?: number;
}

export function createDurableInteractionRecoveryPtyFinalInstruction(
  finalMarker: string
): string {
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(finalMarker)) {
    throw new Error('PTY final marker violates the bounded ASCII contract');
  }
  const midpoint = Math.ceil(finalMarker.length / 2);
  const firstHalf = finalMarker.slice(0, midpoint);
  const secondHalf = finalMarker.slice(midpoint);
  return [
    'Final response protocol: do not call tools.',
    'Your entire response must be derived mechanically from MARKER_TEMPLATE.',
    'Delete the one ~ character from MARKER_TEMPLATE.',
    'Output every remaining character unchanged.',
    'Example only: transforming 123~456 yields 123456.',
    'Copy payload characters literally. Output no labels, delimiters, quotes, ' +
      'spaces, markdown, explanation, or leading/trailing newline.',
    `The result must contain exactly ${finalMarker.length} ASCII characters and match ` +
      `^[A-Za-z0-9_-]{${finalMarker.length}}$.`,
    `MARKER_TEMPLATE=${firstHalf}~${secondHalf}`,
  ].join('\n');
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseDurableInteractionRecoveryPtyEvidence(
  stdout: string,
  secret: string,
  expectedContent: string
): DurableInteractionRecoveryPtyEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SERIALIZED_EVIDENCE_BYTES) {
    throw new Error('Durable interaction PTY evidence exceeded its serialized budget');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (secret && stdout.includes(secret)) {
    throw new Error('Durable interaction PTY evidence contains provider credentials');
  }
  const expectedKeys = [
    'acknowledgements',
    'canaryVisible',
    'completedAttempts',
    'exitCode',
    'exitSignal',
    'failedAttempts',
    'finalMarkerSeen',
    'firstFailureReplaySafe',
    'inboxMissing',
    'interactionRecovered',
    'interactionRequested',
    'interactionResponded',
    'killFallbackUsed',
    'output',
    'pendingAttempts',
    'questionVisible',
    'reviewVisible',
    'secretSeen',
    'sessionId',
    'success',
    'targetSha256',
    'termFallbackUsed',
    'writeCalls',
    'writeResults',
  ];
  if (
    Object.keys(parsed).sort().join('\0') !== expectedKeys.join('\0') ||
    parsed.success !== true ||
    !isNonemptyString(parsed.sessionId) ||
    parsed.questionVisible !== true ||
    parsed.canaryVisible !== true ||
    parsed.reviewVisible !== true ||
    parsed.finalMarkerSeen !== true ||
    parsed.secretSeen !== false ||
    parsed.interactionRequested !== 1 ||
    parsed.interactionResponded !== 1 ||
    parsed.interactionRecovered !== 1 ||
    parsed.pendingAttempts !== 2 ||
    parsed.failedAttempts !== 1 ||
    parsed.completedAttempts !== 1 ||
    parsed.acknowledgements !== 1 ||
    parsed.firstFailureReplaySafe !== true ||
    parsed.writeCalls !== 1 ||
    parsed.writeResults !== 1 ||
    parsed.inboxMissing !== true ||
    parsed.exitCode !== 0 ||
    parsed.exitSignal !== null ||
    parsed.termFallbackUsed !== false ||
    parsed.killFallbackUsed !== false ||
    !/^[a-f0-9]{64}$/.test(String(parsed.targetSha256 ?? '')) ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Durable interaction PTY evidence is incomplete: ${String(
        parsed.error ?? 'unknown'
      )}`
    );
  }
  const expectedSha256 = createHash('sha256').update(expectedContent).digest('hex');
  if (parsed.targetSha256 !== expectedSha256) {
    throw new Error('Durable interaction PTY target digest mismatch');
  }
  return parsed as unknown as DurableInteractionRecoveryPtyEvidence;
}

export async function runDurableInteractionRecoveryPtyDriver(
  input: DurableInteractionRecoveryPtyInput
): Promise<DurableInteractionRecoveryPtyEvidence> {
  if (!input.secret) {
    throw new Error('Durable interaction PTY qualification requires a provider secret');
  }
  const runner = path.resolve(
    import.meta.dirname,
    'durableInteractionRecoveryPtyRunner.ts'
  );
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const { timeoutMs: _timeoutMs, ...runnerInput } = input;
  const outerTimeoutMs = input.timeoutMs ?? 300_000;
  const runnerTimeoutMs = Math.max(1_000, outerTimeoutMs - 15_000);
  const encodedInput = Buffer.from(
    JSON.stringify({ ...runnerInput, cliEntry, runnerTimeoutMs }),
    'utf8'
  ).toString('base64');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_DURABLE_INTERACTION_PTY_INPUT: encodedInput,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );

  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(resolveBunExecutable(), [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: outerTimeoutMs,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const failureStdout = String(failure.stdout ?? '');
    if (failureStdout.includes(input.secret)) {
      throw new Error('Durable interaction PTY failure evidence contains credentials');
    }
    try {
      const safeFailure =
        parseDurableInteractionRecoveryPtyFailureEvidence(failureStdout);
      throw new Error(`Durable interaction PTY failed: ${JSON.stringify(safeFailure)}`);
    } catch (parseError) {
      if (
        parseError instanceof Error &&
        parseError.message.startsWith('Durable interaction PTY failed:')
      )
        throw parseError;
      throw new Error('Durable interaction PTY runner failed without safe evidence');
    }
  }

  const evidence = parseDurableInteractionRecoveryPtyEvidence(
    String(result.stdout),
    input.secret,
    input.expectedContent
  );
  if (evidence.sessionId !== input.sessionId) {
    throw new Error('Durable interaction PTY evidence belongs to another Session');
  }
  return evidence;
}

interface SafeFailureEvidence {
  success: false;
  stage: string;
  code: string;
  timedOut: boolean;
  secretSeen: boolean;
  termFallbackUsed: boolean;
  killFallbackUsed: boolean;
  reason: SafeFailureReason;
  snapshot: SafeCompletionSnapshot | null;
}

type BoundedCount = 0 | 1 | 2 | '3plus';
type SafeFailureReason =
  | 'invalid_input'
  | 'seed_invalid'
  | 'spawn_failed'
  | 'question_timeout'
  | 'review_timeout'
  | 'completion_timeout'
  | 'shutdown_failed'
  | 'duplicate_interaction'
  | 'invalid_question'
  | 'invalid_response'
  | 'invalid_recovery_result'
  | 'duplicate_turn'
  | 'duplicate_acknowledgement'
  | 'duplicate_completion'
  | 'invalid_write'
  | 'invalid_order'
  | 'secret_detected';

interface SafeCompletionSnapshot {
  interactionRequested: BoundedCount;
  interactionResponded: BoundedCount;
  interactionRecovered: BoundedCount;
  recoveryToolResults: BoundedCount;
  writeCalls: BoundedCount;
  writeResults: BoundedCount;
  successfulWriteResults: BoundedCount;
  turnStarts: BoundedCount;
  acknowledgements: BoundedCount;
  turnCompleted: BoundedCount;
  turnAborted: BoundedCount;
  targetState: 'missing' | 'matched' | 'mismatched' | 'unreadable';
  inboxMissing: boolean | null;
  durableFinalState: 'missing' | 'matched' | 'mismatched';
  surfaceFinalSeen: boolean;
  questionVisible: boolean;
  reviewVisible: boolean;
  childExitState: 'running' | 'clean' | 'failed' | 'signaled';
}

const SAFE_FAILURE_STAGES = new Set([
  'input',
  'seed',
  'spawn',
  'question',
  'review',
  'completion',
  'shutdown',
]);
const SAFE_FAILURE_CODES = new Set([
  'invalid_input',
  'seed_invalid',
  'spawn_failed',
  'timeout',
  'qualification_failed',
  'shutdown_failed',
]);
const SAFE_FAILURE_REASONS = new Set<SafeFailureReason>([
  'invalid_input',
  'seed_invalid',
  'spawn_failed',
  'question_timeout',
  'review_timeout',
  'completion_timeout',
  'shutdown_failed',
  'duplicate_interaction',
  'invalid_question',
  'invalid_response',
  'invalid_recovery_result',
  'duplicate_turn',
  'duplicate_acknowledgement',
  'duplicate_completion',
  'invalid_write',
  'invalid_order',
  'secret_detected',
]);
const COUNT_VALUES = new Set<unknown>([0, 1, 2, '3plus']);

function isSafeSnapshot(value: unknown): value is SafeCompletionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const keys = [
    'acknowledgements',
    'childExitState',
    'durableFinalState',
    'inboxMissing',
    'interactionRecovered',
    'interactionRequested',
    'interactionResponded',
    'questionVisible',
    'recoveryToolResults',
    'reviewVisible',
    'successfulWriteResults',
    'surfaceFinalSeen',
    'targetState',
    'turnAborted',
    'turnCompleted',
    'turnStarts',
    'writeCalls',
    'writeResults',
  ];
  const countKeys = [
    'interactionRequested',
    'interactionResponded',
    'interactionRecovered',
    'recoveryToolResults',
    'writeCalls',
    'writeResults',
    'successfulWriteResults',
    'turnStarts',
    'acknowledgements',
    'turnCompleted',
    'turnAborted',
  ];
  return (
    Object.keys(snapshot).sort().join('\0') === keys.join('\0') &&
    countKeys.every((key) => COUNT_VALUES.has(snapshot[key])) &&
    ['missing', 'matched', 'mismatched', 'unreadable'].includes(
      String(snapshot.targetState)
    ) &&
    (snapshot.inboxMissing === null || typeof snapshot.inboxMissing === 'boolean') &&
    ['missing', 'matched', 'mismatched'].includes(String(snapshot.durableFinalState)) &&
    typeof snapshot.surfaceFinalSeen === 'boolean' &&
    typeof snapshot.questionVisible === 'boolean' &&
    typeof snapshot.reviewVisible === 'boolean' &&
    ['running', 'clean', 'failed', 'signaled'].includes(String(snapshot.childExitState))
  );
}

export function parseDurableInteractionRecoveryPtyFailureEvidence(
  stdout: string
): SafeFailureEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SERIALIZED_EVIDENCE_BYTES)
    throw new Error('Durable interaction PTY safe failure evidence is invalid');
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const keys = [
      'code',
      'killFallbackUsed',
      'reason',
      'secretSeen',
      'snapshot',
      'stage',
      'success',
      'termFallbackUsed',
      'timedOut',
    ];
    if (
      Object.keys(parsed).sort().join('\0') !== keys.join('\0') ||
      parsed.success !== false ||
      !isNonemptyString(parsed.stage) ||
      !SAFE_FAILURE_STAGES.has(parsed.stage) ||
      !isNonemptyString(parsed.code) ||
      !SAFE_FAILURE_CODES.has(parsed.code) ||
      typeof parsed.timedOut !== 'boolean' ||
      typeof parsed.secretSeen !== 'boolean' ||
      typeof parsed.termFallbackUsed !== 'boolean' ||
      typeof parsed.killFallbackUsed !== 'boolean' ||
      !SAFE_FAILURE_REASONS.has(parsed.reason as SafeFailureReason) ||
      !(parsed.snapshot === null || isSafeSnapshot(parsed.snapshot))
    ) {
      throw new Error('Durable interaction PTY safe failure evidence is invalid');
    }
    return parsed as unknown as SafeFailureEvidence;
  } catch {
    throw new Error('Durable interaction PTY safe failure evidence is invalid');
  }
}
