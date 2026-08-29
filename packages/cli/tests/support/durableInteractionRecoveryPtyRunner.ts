import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../src/context/types.js';
import { finalAssistantText } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import {
  InvalidDurableInteractionPtyLifecycleError,
  inspectDurableInteractionPtyRetryLifecycle,
  pollDurableInteractionPtyCompletion,
} from './durableInteractionRecoveryPtyDriver.js';
import {
  ArmedPtyMarkerLatch,
  appendBoundedPtyEvidence,
  projectForegroundBoundedPtyOutput,
  waitForPtyExit,
} from './foregroundBoundedOutputPtyDriver.js';
import { createTuiPtyEnvironment } from './ptyInput.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  requestId: string;
  target: string;
  expectedContent: string;
  finalMarker: string;
  secret: string;
  runnerTimeoutMs: number;
}

interface CompletionEvidence {
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
}
type BoundedCount = 0 | 1 | 2 | '3plus';
interface CompletionSnapshot {
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
type CompletionReason =
  | 'waiting'
  | 'duplicate_interaction'
  | 'invalid_question'
  | 'invalid_response'
  | 'invalid_recovery_result'
  | 'duplicate_turn'
  | 'duplicate_acknowledgement'
  | 'duplicate_completion'
  | 'invalid_write'
  | 'invalid_order';
type CompletionAnalysis =
  | { state: 'complete'; evidence: CompletionEvidence; snapshot: CompletionSnapshot }
  | {
      state: 'waiting' | 'invalid';
      reason: CompletionReason;
      snapshot: CompletionSnapshot;
    };
function boundedCount(value: number): BoundedCount {
  return value > 2 ? '3plus' : (value as 0 | 1 | 2);
}

class SafeRunnerFailure extends Error {
  readonly stage: 'seed' | 'spawn';
  readonly code: 'seed_invalid' | 'spawn_failed';

  constructor(stage: 'seed' | 'spawn', code: 'seed_invalid' | 'spawn_failed') {
    super(code);
    this.stage = stage;
    this.code = code;
  }
}
class SafeCompletionFailure extends Error {
  readonly reason: Exclude<CompletionReason, 'waiting'>;
  readonly snapshot: CompletionSnapshot;
  constructor(
    reason: Exclude<CompletionReason, 'waiting'>,
    snapshot: CompletionSnapshot
  ) {
    super('completion_invalid');
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

const MAX_ENCODED_INPUT_BYTES = 256 * 1024;
const MAX_DURABLE_EVIDENCE_BYTES = 8 * 1024 * 1024;

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_DURABLE_INTERACTION_PTY_INPUT;
  if (!encoded) throw new Error('Missing BLADE_DURABLE_INTERACTION_PTY_INPUT');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENCODED_INPUT_BYTES) {
    throw new Error('Durable interaction PTY input exceeds its bounded size');
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Invalid durable interaction PTY input encoding');
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64') !== encoded) {
    throw new Error('Non-canonical durable interaction PTY input encoding');
  }
  const input = JSON.parse(decoded) as RunnerInput;
  const keys = [
    'cliEntry',
    'expectedContent',
    'finalMarker',
    'home',
    'requestId',
    'runnerTimeoutMs',
    'secret',
    'sessionId',
    'storageRoot',
    'target',
    'workspace',
  ];
  if (Object.keys(input).sort().join('\0') !== keys.join('\0')) {
    throw new Error('Invalid durable interaction PTY input fields');
  }
  for (const name of keys.filter((name) => name !== 'runnerTimeoutMs')) {
    if (
      typeof input[name as keyof RunnerInput] !== 'string' ||
      !input[name as keyof RunnerInput]
    )
      throw new Error(`Invalid durable interaction PTY setting: ${name}`);
  }
  if (!Number.isSafeInteger(input.runnerTimeoutMs) || input.runnerTimeoutMs < 1_000) {
    throw new Error('Invalid durable interaction PTY runner timeout');
  }
  for (const value of [
    input.cliEntry,
    input.workspace,
    input.storageRoot,
    input.home,
    input.target,
  ]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) {
      throw new Error('Durable interaction PTY paths must be canonical and absolute');
    }
  }
  if (
    path.basename(input.cliEntry) !== 'blade.js' ||
    path.basename(path.dirname(input.cliEntry)) !== 'dist'
  ) {
    throw new Error('Durable interaction PTY CLI entry must be dist/blade.js');
  }
  const relativeTarget = path.relative(input.workspace, input.target);
  if (
    !relativeTarget ||
    relativeTarget.startsWith('..') ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(
      'Durable interaction PTY target must be contained by the workspace'
    );
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedEventsJson(events: readonly SessionEvent[]): string | undefined {
  const serialized = JSON.stringify(events);
  return Buffer.byteLength(serialized, 'utf8') <= MAX_DURABLE_EVIDENCE_BYTES
    ? serialized
    : undefined;
}

function signalTerminalTree(
  pid: number,
  signal: NodeJS.Signals,
  fallback: () => void
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      try {
        fallback();
      } catch {
        // The terminal process already exited.
      }
    }
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  deadline: number
): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      if (error instanceof SafeCompletionFailure) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
}

async function writeJson(value: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(value), () => resolve());
  });
}

async function inboxIsMissing(workspace: string, sessionId: string): Promise<boolean> {
  try {
    await access(getSessionInboxFilePath(workspace, sessionId));
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true;
    throw error;
  }
}

function matchingInteractions(
  events: readonly SessionEvent[],
  type: 'interaction_requested' | 'interaction_responded' | 'interaction_recovered',
  requestId: string
): SessionEvent[] {
  return events.filter(
    (event) => event.type === type && event.data.requestId === requestId
  );
}

function eventIndex(events: readonly SessionEvent[], event: SessionEvent): number {
  return events.indexOf(event);
}

function writeEvidence(events: readonly SessionEvent[]): {
  calls: Array<{ toolCallId: string; input: Record<string, unknown> }>;
  results: Array<{ toolCallId: string; succeeded: boolean }>;
} {
  const calls: Array<{ toolCallId: string; input: Record<string, unknown> }> = [];
  const results: Array<{ toolCallId: string; succeeded: boolean }> = [];
  for (const event of events) {
    if (event.type !== 'part_created' || !isRecord(event.data.payload)) continue;
    const payload = event.data.payload;
    if (payload.toolName !== 'Write' || typeof payload.toolCallId !== 'string')
      continue;
    if (event.data.partType === 'tool_call' && isRecord(payload.input)) {
      calls.push({ toolCallId: payload.toolCallId, input: payload.input });
    } else if (event.data.partType === 'tool_result') {
      results.push({
        toolCallId: payload.toolCallId,
        succeeded: payload.error === null && payload.output !== null,
      });
    }
  }
  return { calls, results };
}

async function computeDurableCompletionEvidence(
  input: RunnerInput
): Promise<CompletionEvidence | undefined> {
  const events =
    (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
  const requests = matchingInteractions(
    events,
    'interaction_requested',
    input.requestId
  );
  const responses = matchingInteractions(
    events,
    'interaction_responded',
    input.requestId
  );
  const recoveries = matchingInteractions(
    events,
    'interaction_recovered',
    input.requestId
  );
  if (
    events.filter((event) => event.type === 'interaction_requested').length !== 1 ||
    events.filter((event) => event.type === 'interaction_responded').length !== 1 ||
    events.filter((event) => event.type === 'interaction_recovered').length !== 1 ||
    requests.length !== 1 ||
    responses.length !== 1 ||
    recoveries.length !== 1
  ) {
    return undefined;
  }
  const request = requests[0];
  const response = responses[0];
  if (
    request?.type !== 'interaction_requested' ||
    request.data.toolName !== 'AskUserQuestion' ||
    request.data.interactionType !== 'question' ||
    !isRecord(request.data.details) ||
    !Array.isArray(request.data.details.questions) ||
    request.data.details.questions.length !== 1 ||
    !isRecord(request.data.details.questions[0]) ||
    request.data.details.questions[0].header !== 'Channel' ||
    request.data.details.questions[0].question !== 'Which release channel?' ||
    request.data.details.questions[0].multiSelect !== false ||
    !Array.isArray(request.data.details.questions[0].options) ||
    request.data.details.questions[0].options.length !== 2 ||
    !isRecord(request.data.details.questions[0].options[0]) ||
    !isRecord(request.data.details.questions[0].options[1]) ||
    request.data.details.questions[0].options[0].label !== 'Stable' ||
    request.data.details.questions[0].options[1].label !== 'Canary' ||
    response?.type !== 'interaction_responded' ||
    !isRecord(response.data.response) ||
    response.data.response.approved !== true ||
    !isRecord(response.data.response.answers) ||
    response.data.response.answers.Channel !== 'Canary'
  ) {
    return undefined;
  }
  const recovery = recoveries[0];
  const inboxMessageId =
    recovery?.type === 'interaction_recovered'
      ? recovery.data.inboxMessageId
      : undefined;
  if (!inboxMessageId) return undefined;
  const recoveryResults = events.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolName === 'AskUserQuestion' &&
      event.data.payload.toolCallId === request.data.toolCallId &&
      isRecord(event.data.payload.metadata) &&
      event.data.payload.metadata.interactionRecovery === true &&
      event.data.payload.metadata.requestId === input.requestId
  );
  if (recoveryResults.length !== 1) return undefined;
  if (
    !response ||
    !recovery ||
    !(
      eventIndex(events, request) < eventIndex(events, response) &&
      eventIndex(events, response) < eventIndex(events, recoveryResults[0]!) &&
      eventIndex(events, recoveryResults[0]!) < eventIndex(events, recovery)
    )
  ) {
    return undefined;
  }
  const lifecycle = inspectDurableInteractionPtyRetryLifecycle(events, inboxMessageId);
  if (!lifecycle) return undefined;
  const completed = events[lifecycle.completion.index];
  if (completed?.type !== 'turn_completed') return undefined;
  const finalTerminal = events.findLast(
    (event) => event.type === 'turn_completed' || event.type === 'turn_aborted'
  );
  if (finalTerminal !== completed || finalAssistantText(events) !== input.finalMarker)
    return undefined;

  const write = writeEvidence(events);
  if (write.calls.length !== 1 || write.results.length !== 1) return undefined;
  const call = write.calls[0];
  const result = write.results[0];
  if (
    !call ||
    !result?.succeeded ||
    result.toolCallId !== call.toolCallId ||
    call.input.file_path !== input.target ||
    call.input.content !== input.expectedContent
  ) {
    return undefined;
  }
  const writeCallEvent = events.find(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_call' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolCallId === call.toolCallId
  );
  const writeResultEvent = events.find(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      isRecord(event.data.payload) &&
      event.data.payload.toolCallId === call.toolCallId
  );
  if (
    !writeCallEvent ||
    !writeResultEvent ||
    !(
      eventIndex(events, recovery) < lifecycle.firstAttempt.index &&
      lifecycle.firstAttempt.index < lifecycle.firstFailure.index &&
      lifecycle.firstFailure.index < lifecycle.completedAttempt.index &&
      lifecycle.completedAttempt.index < eventIndex(events, writeCallEvent) &&
      eventIndex(events, writeCallEvent) < eventIndex(events, writeResultEvent) &&
      eventIndex(events, writeResultEvent) < lifecycle.acknowledgement.index &&
      lifecycle.acknowledgement.index < lifecycle.completion.index
    )
  ) {
    return undefined;
  }
  const targetContent = await readFile(input.target, 'utf8').catch(() => undefined);
  if (targetContent !== input.expectedContent) return undefined;
  if (!(await inboxIsMissing(input.workspace, input.sessionId))) return undefined;

  return {
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
    targetSha256: createHash('sha256').update(targetContent).digest('hex'),
  };
}

async function analyzeDurableCompletion(
  input: RunnerInput,
  surface: { questionVisible: boolean; reviewVisible: boolean; finalSeen: boolean },
  childExitState: CompletionSnapshot['childExitState']
): Promise<CompletionAnalysis> {
  const events =
    (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
  const count = (type: SessionEvent['type']) =>
    events.filter((event) => event.type === type).length;
  const recovery = events.find(
    (event) =>
      event.type === 'interaction_recovered' && event.data.requestId === input.requestId
  );
  const inboxMessageId =
    recovery?.type === 'interaction_recovered'
      ? recovery.data.inboxMessageId
      : undefined;
  const writes = writeEvidence(events);
  let targetState: CompletionSnapshot['targetState'] = 'missing';
  try {
    const content = await readFile(input.target, 'utf8');
    targetState = content === input.expectedContent ? 'matched' : 'mismatched';
  } catch (error) {
    targetState =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'missing'
        : 'unreadable';
  }
  const final = finalAssistantText(events);
  const snapshot: CompletionSnapshot = {
    interactionRequested: boundedCount(count('interaction_requested')),
    interactionResponded: boundedCount(count('interaction_responded')),
    interactionRecovered: boundedCount(count('interaction_recovered')),
    recoveryToolResults: boundedCount(
      events.filter(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          isRecord(event.data.payload) &&
          isRecord(event.data.payload.metadata) &&
          event.data.payload.metadata.interactionRecovery === true
      ).length
    ),
    writeCalls: boundedCount(writes.calls.length),
    writeResults: boundedCount(writes.results.length),
    successfulWriteResults: boundedCount(
      writes.results.filter((result) => result.succeeded).length
    ),
    turnStarts: boundedCount(
      inboxMessageId
        ? events.filter(
            (event) =>
              event.type === 'turn_started' &&
              event.data.inputMessageIds?.includes(inboxMessageId)
          ).length
        : 0
    ),
    acknowledgements: boundedCount(
      inboxMessageId
        ? events.filter(
            (event) =>
              event.type === 'inbox_acknowledged' &&
              event.data.messageIds.includes(inboxMessageId)
          ).length
        : 0
    ),
    turnCompleted: boundedCount(count('turn_completed')),
    turnAborted: boundedCount(count('turn_aborted')),
    targetState,
    inboxMissing: await inboxIsMissing(input.workspace, input.sessionId).catch(
      () => null
    ),
    durableFinalState:
      final === undefined
        ? 'missing'
        : final === input.finalMarker
          ? 'matched'
          : 'mismatched',
    surfaceFinalSeen: surface.finalSeen,
    questionVisible: surface.questionVisible,
    reviewVisible: surface.reviewVisible,
    childExitState,
  };
  if (
    [
      snapshot.interactionRequested,
      snapshot.interactionResponded,
      snapshot.interactionRecovered,
    ].some((count) => count === 2 || count === '3plus')
  )
    return { state: 'invalid', reason: 'duplicate_interaction', snapshot };
  if (snapshot.turnStarts === '3plus')
    return { state: 'invalid', reason: 'duplicate_turn', snapshot };
  if (snapshot.acknowledgements === 2 || snapshot.acknowledgements === '3plus')
    return { state: 'invalid', reason: 'duplicate_acknowledgement', snapshot };
  if (
    snapshot.writeCalls === 2 ||
    snapshot.writeCalls === '3plus' ||
    snapshot.writeResults === 2 ||
    snapshot.writeResults === '3plus'
  )
    return { state: 'invalid', reason: 'invalid_write', snapshot };
  let evidence: CompletionEvidence | undefined;
  try {
    evidence = await computeDurableCompletionEvidence(input);
  } catch (error) {
    if (error instanceof InvalidDurableInteractionPtyLifecycleError) {
      return { state: 'invalid', reason: error.reason, snapshot };
    }
    throw error;
  }
  return evidence
    ? { state: 'complete', evidence, snapshot }
    : { state: 'waiting', reason: 'waiting', snapshot };
}

async function main(): Promise<void> {
  const input = loadInput();
  let existingEvents: SessionEvent[];
  try {
    existingEvents =
      (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
  } catch {
    throw new SafeRunnerFailure('seed', 'seed_invalid');
  }
  const existingEventsJson = boundedEventsJson(existingEvents);
  if (!existingEventsJson) throw new Error('Durable interaction seed is too large');
  if (existingEventsJson.includes(input.secret)) {
    throw new Error('Durable interaction seed contained credentials');
  }
  if (JSON.stringify(existingEvents).includes(input.finalMarker)) {
    throw new Error(
      'Durable interaction final marker contaminated the seeded transcript'
    );
  }

  const finalMarkerLatch = new ArmedPtyMarkerLatch(input.finalMarker);
  const secretLatch = new ArmedPtyMarkerLatch(input.secret);
  secretLatch.arm();
  const childEnv = createTuiPtyEnvironment({
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
    BLADE_VERSION: '999.0.0',
  });
  delete childEnv.BLADE_DURABLE_INTERACTION_PTY_INPUT;
  let terminal: ReturnType<typeof spawn>;
  try {
    terminal = spawn(
      '/usr/bin/env',
      [
        'node',
        input.cliEntry,
        '--trust-workspace',
        '--permission-mode',
        'yolo',
        '--max-turns',
        '4',
        '--resume',
        input.sessionId,
        '--allowed-tools',
        'Write',
        '--no-verification-agent',
      ],
      {
        name: 'xterm-256color',
        cwd: input.workspace,
        cols: 120,
        rows: 40,
        env: childEnv,
      }
    );
  } catch {
    throw new SafeRunnerFailure('spawn', 'spawn_failed');
  }
  let output = '';
  let plainOutput = '';
  let questionVisible = false;
  let canaryVisible = false;
  let reviewVisible = false;
  let reviewOutputOffset = Number.POSITIVE_INFINITY;
  let exited = false;
  let exitCode: number | undefined;
  let exitSignal: number | string | null = null;
  let termFallbackUsed = false;
  let killFallbackUsed = false;
  let lastCompletionSnapshot: CompletionSnapshot | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit((event: { exitCode: number; signal?: number | string }) => {
      exited = true;
      exitCode = event.exitCode;
      exitSignal = event.signal ?? null;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    secretLatch.observe(chunk);
    finalMarkerLatch.observe(chunk);
    output = appendBoundedPtyEvidence(output, chunk, 256_000);
    plainOutput = appendBoundedPtyEvidence(
      plainOutput,
      stripVTControlCharacters(chunk),
      64_000
    );
    questionVisible ||=
      plainOutput.includes('Which release channel?') &&
      plainOutput.includes('Enter to select');
    canaryVisible ||= plainOutput.includes('2. Canary');
    const reviewEpoch = plainOutput.slice(reviewOutputOffset);
    reviewVisible ||=
      reviewEpoch.includes('Review Your Answers') &&
      reviewEpoch.includes('Submit answers') &&
      reviewEpoch.includes('Canary');
  });

  try {
    const deadline = Date.now() + input.runnerTimeoutMs;
    await Promise.race([
      waitFor(
        () => questionVisible && canaryVisible,
        'Timed out waiting for the durable Channel question in the raw TUI',
        deadline
      ),
      exitPromise.then(() => {
        throw new Error(
          `Durable interaction TUI exited before the question (${exitCode})`
        );
      }),
    ]);
    reviewOutputOffset = plainOutput.length;
    terminal.write('2');
    await waitFor(
      () => reviewVisible,
      'Timed out waiting for the Canary answer review in the raw TUI',
      deadline
    );
    finalMarkerLatch.arm();
    terminal.write('y');

    const completion = await pollDurableInteractionPtyCompletion({
      deadlineAt: deadline,
      inspect: async () => {
        const analysis = await analyzeDurableCompletion(
          input,
          {
            questionVisible,
            reviewVisible,
            finalSeen: finalMarkerLatch.seen,
          },
          exited
            ? exitSignal === null && exitCode === 0
              ? 'clean'
              : exitSignal
                ? 'signaled'
                : 'failed'
            : 'running'
        );
        lastCompletionSnapshot = analysis.snapshot;
        if (analysis.state === 'invalid') {
          throw new SafeCompletionFailure(
            analysis.reason as Exclude<CompletionReason, 'waiting'>,
            analysis.snapshot
          );
        }
        return analysis.state === 'complete' ? analysis.evidence : undefined;
      },
    });
    await waitFor(
      () => finalMarkerLatch.seen,
      'Raw TUI did not render the durable interaction final marker',
      deadline
    );
    if (secretLatch.seen) {
      throw new Error('Raw TUI durable interaction capture contained credentials');
    }
    const finalEvents =
      (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
    const finalEventsJson = boundedEventsJson(finalEvents);
    if (!finalEventsJson) throw new Error('Durable interaction evidence is too large');
    const finalTarget = await readFile(input.target, 'utf8');
    if (finalEventsJson.includes(input.secret) || finalTarget.includes(input.secret)) {
      throw new Error('Durable interaction evidence contained credentials');
    }

    terminal.write('\u0004');
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.write('\u0004');
    await waitForPtyExit(
      exitPromise,
      'Durable interaction TUI did not exit after Ctrl-D',
      15_000
    );
    if (exitCode !== 0 || exitSignal !== null) {
      throw new Error('Durable interaction TUI did not exit cleanly');
    }
    const successEvidence = {
      success: true,
      sessionId: input.sessionId,
      questionVisible,
      canaryVisible,
      reviewVisible,
      finalMarkerSeen: finalMarkerLatch.seen,
      secretSeen: secretLatch.seen,
      exitCode: 0,
      exitSignal: null,
      termFallbackUsed,
      killFallbackUsed,
      ...completion,
      output: projectForegroundBoundedPtyOutput(
        [
          'Durable question visible',
          'Canary option visible',
          'Answer review visible',
          'Durable completion observed',
          'Final marker rendered',
        ].join('\n')
      ),
    };
    if (JSON.stringify(successEvidence).includes(input.secret)) {
      throw new Error('Durable interaction success evidence contained credentials');
    }
    await writeJson(successEvidence);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.message.startsWith('Timed out') || error.message.includes('did not exit'));
    if (!exited) {
      termFallbackUsed = true;
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(exitPromise, 'PTY cleanup TERM timeout', 2_000).catch(
        () => undefined
      );
    }
    if (!exited) {
      killFallbackUsed = true;
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
      await waitForPtyExit(exitPromise, 'PTY cleanup KILL timeout', 1_000).catch(
        () => undefined
      );
    }
    await writeJson({
      success: false,
      stage: reviewVisible ? 'completion' : questionVisible ? 'review' : 'question',
      code: timedOut ? 'timeout' : 'qualification_failed',
      timedOut,
      secretSeen: secretLatch.seen,
      termFallbackUsed,
      killFallbackUsed,
      reason:
        error instanceof SafeCompletionFailure
          ? error.reason
          : timedOut
            ? reviewVisible
              ? 'completion_timeout'
              : questionVisible
                ? 'review_timeout'
                : 'question_timeout'
            : 'invalid_order',
      snapshot:
        error instanceof SafeCompletionFailure
          ? error.snapshot
          : lastCompletionSnapshot,
    });
    process.exitCode = 1;
  } finally {
    if (!exited && !termFallbackUsed) {
      termFallbackUsed = true;
      signalTerminalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
      await waitForPtyExit(
        exitPromise,
        'Durable interaction TUI did not exit during cleanup',
        2_000
      ).catch(() => undefined);
    }
    if (!exited && !killFallbackUsed) {
      killFallbackUsed = true;
      signalTerminalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
      await waitForPtyExit(exitPromise, 'PTY cleanup KILL timeout', 1_000).catch(
        () => undefined
      );
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const failure = error instanceof SafeRunnerFailure ? error : undefined;
    await writeJson({
      success: false,
      stage: failure?.stage ?? 'input',
      code: failure?.code ?? 'invalid_input',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
      reason:
        failure?.code === 'seed_invalid'
          ? 'seed_invalid'
          : failure?.code === 'spawn_failed'
            ? 'spawn_failed'
            : 'invalid_input',
      snapshot: null,
    });
    process.exitCode = 1;
  }
}
