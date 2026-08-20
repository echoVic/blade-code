import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseCompactionReplacementMessages } from '../../../src/context/compactionCheckpoint.js';
import {
  isTokenBudgetHandoffEvent,
  isTokenBudgetHandoffMessage,
  parseTokenBudgetHandoffEvent,
  projectTokenBudgetHandoffEvent,
  TOKEN_BUDGET_HANDOFF_TAG,
} from '../../../src/context/TokenBudgetHandoff.js';
import type { SessionEvent } from '../../../src/context/types.js';
import type { TokenBudgetProxyEvidence } from '../../support/tokenBudgetHandoffProxy.js';
import {
  assertNoSecrets,
  type DurableToolTraceRecord,
  extractDurableToolTrace,
} from './sessionForkTrajectoryHarness.js';
import type { TokenBudgetHandoffFixture } from './tokenBudgetHandoffFixture.js';

export interface TokenBudgetHandoffSurfaceEvidence {
  surface: 'headless' | 'pty' | 'web' | 'acp';
  sessionId: string;
  finalMarkerSeen: boolean;
  hiddenMarkerSeen: boolean;
  recovery: {
    kind: 'cold_projection' | 'pty_resume' | 'web_reload' | 'acp_load';
    completed: boolean;
    providerRequestsBefore: number;
    providerRequestsAfter: number;
  };
  faults: string[];
}

const LEDGER_SECTION_KEYS = [
  'objectiveAndConstraints',
  'decisionsAndRationale',
  'workspaceMutations',
  'verificationEvidence',
  'activeTasksAndBackgroundWork',
  'openRisksOrBlockers',
  'exactNextAction',
] as const;

type LedgerSectionKey = (typeof LEDGER_SECTION_KEYS)[number];

const LEDGER_HEADINGS = new Map<string, LedgerSectionKey>([
  ['objective and constraints', 'objectiveAndConstraints'],
  ['decisions and rationale', 'decisionsAndRationale'],
  ['workspace mutations', 'workspaceMutations'],
  ['verification evidence', 'verificationEvidence'],
  ['active tasks and background work', 'activeTasksAndBackgroundWork'],
  ['open risks or blockers', 'openRisksOrBlockers'],
  ['exact next action', 'exactNextAction'],
]);

const HIDDEN_HANDOFF_EVENT_TYPE = 'token_budget_handoff_recorded';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyLedger(): Record<LedgerSectionKey, string> {
  return {
    objectiveAndConstraints: '',
    decisionsAndRationale: '',
    workspaceMutations: '',
    verificationEvidence: '',
    activeTasksAndBackgroundWork: '',
    openRisksOrBlockers: '',
    exactNextAction: '',
  };
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeListLine(value: string): string {
  return value
    .trim()
    .replace(/^(?:[-+*]|\d+[.)])\s+/, '')
    .trim();
}

export function parseContinuationLedger(summary: string): Record<string, string> {
  const sections = emptyLedger();
  const observed = new Set<LedgerSectionKey>();
  let current: LedgerSectionKey | undefined;

  for (const line of summary.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const headingText = heading[1];
      if (!headingText) {
        current = undefined;
        continue;
      }
      const key = LEDGER_HEADINGS.get(normalizeHeading(headingText));
      if (!key) {
        current = undefined;
        continue;
      }
      if (observed.has(key)) {
        throw new Error(`Continuation ledger contains duplicate ${key} heading`);
      }
      if (key !== LEDGER_SECTION_KEYS[observed.size]) {
        throw new Error('Continuation ledger heading order is invalid');
      }
      observed.add(key);
      current = key;
      continue;
    }

    if (!current) continue;
    const isListItem = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line);
    const isIndentedContinuation = !isListItem && /^\s{2,}\S/.test(line);
    const normalized = normalizeListLine(line);
    if (!normalized) continue;
    if (isIndentedContinuation && sections[current]) {
      const clauses = sections[current].split('\n');
      const lastClause = clauses.pop();
      clauses.push(lastClause ? `${lastClause} ${normalized}` : normalized);
      sections[current] = clauses.join('\n');
    } else {
      sections[current] = sections[current]
        ? `${sections[current]}\n${normalized}`
        : normalized;
    }
  }

  return sections;
}

function requireSentinel(
  sections: Record<string, string>,
  section: LedgerSectionKey,
  sentinel: string,
  label: string
): void {
  if (!sections[section]?.includes(sentinel)) {
    throw new Error(`Continuation ledger ${label} sentinel is missing from ${section}`);
  }
}

function sentinelAppearsWith(
  sections: Record<string, string>,
  sentinel: string,
  contradictoryStatus: RegExp
): boolean {
  return LEDGER_SECTION_KEYS.some((key) =>
    (sections[key] ?? '')
      .split(/\r?\n/)
      .some((clause) =>
        clause.includes(sentinel) ? contradictoryStatus.test(clause) : false
      )
  );
}

function sentinelAppearsOutside(
  sections: Record<string, string>,
  allowed: LedgerSectionKey,
  sentinel: string
): boolean {
  return LEDGER_SECTION_KEYS.some(
    (key) => key !== allowed && (sections[key] ?? '').includes(sentinel)
  );
}

export function assertContinuationLedger(
  sections: Record<string, string>,
  sentinels: TokenBudgetHandoffFixture['sentinels']
): void {
  for (const key of LEDGER_SECTION_KEYS) {
    if (!sections[key]) {
      throw new Error(`Continuation ledger required section ${key} is missing`);
    }
  }
  requireSentinel(sections, 'workspaceMutations', sentinels.mutation, 'mutation');
  if (sentinelAppearsOutside(sections, 'workspaceMutations', sentinels.mutation)) {
    throw new Error('Continuation ledger mutation sentinel appears outside mutations');
  }
  requireSentinel(
    sections,
    'verificationEvidence',
    sentinels.failedVerification,
    'failed verification'
  );
  if (
    sentinelAppearsOutside(
      sections,
      'verificationEvidence',
      sentinels.failedVerification
    )
  ) {
    throw new Error(
      'Continuation ledger failed verification sentinel appears outside verification'
    );
  }
  requireSentinel(
    sections,
    'exactNextAction',
    sentinels.pendingAction,
    'pending action'
  );
  if (sentinelAppearsOutside(sections, 'exactNextAction', sentinels.pendingAction)) {
    throw new Error(
      'Continuation ledger pending action sentinel appears outside next action'
    );
  }

  if (
    sentinelAppearsWith(
      sections,
      sentinels.pendingAction,
      /\b(?:complete|completed|done|finished|resolved)\b/i
    )
  ) {
    throw new Error('Continuation ledger pending action sentinel is marked completed');
  }
  if (
    sentinelAppearsWith(
      sections,
      sentinels.failedVerification,
      /\b(?:pass|passed|passing|success|succeeded|successful)\b/i
    )
  ) {
    throw new Error(
      'Continuation ledger failed verification sentinel is marked passing'
    );
  }
}

function assertRequestShape(
  request: TokenBudgetProxyEvidence['requests'][number],
  index: number
): void {
  if (request.ordinal !== index + 1) {
    throw new Error(`Token-budget request ${index + 1} has an invalid ordinal`);
  }
  if (
    !Number.isSafeInteger(request.bodyBytes) ||
    request.bodyBytes <= 0 ||
    request.bodyBytes > MAX_REQUEST_BODY_BYTES
  ) {
    throw new Error(`Token-budget request ${index + 1} has invalid body bytes`);
  }
  if (!SHA256_PATTERN.test(request.bodySha256)) {
    throw new Error(`Token-budget request ${index + 1} has an invalid body hash`);
  }
}

export function assertTokenBudgetRequestSequence(
  evidence: TokenBudgetProxyEvidence,
  targets: { handoffPromptTokens: number; compactionPromptTokens: number }
): void {
  if (evidence.maxInFlight !== 1) {
    throw new Error('Token-budget Provider requests must have maxInFlight equal to 1');
  }
  if (evidence.requests.length !== 5) {
    throw new Error(
      'Token-budget Provider evidence must contain exactly five requests'
    );
  }

  const expected = [
    {
      kind: 'task',
      marker: 0,
      target: targets.handoffPromptTokens,
      rewritten: true,
    },
    {
      kind: 'task',
      marker: 1,
      target: targets.compactionPromptTokens,
      rewritten: true,
    },
    { kind: 'compaction', marker: 0, rewritten: false },
    { kind: 'task', marker: 0, rewritten: false },
    { kind: 'task', marker: 0, rewritten: false },
  ] as const;

  for (const [index, request] of evidence.requests.entries()) {
    assertRequestShape(request, index);
    const contract = expected[index];
    if (!contract) {
      throw new Error('Token-budget Provider request contract is missing');
    }
    if (request.kind !== contract.kind) {
      throw new Error(`Token-budget request ${index + 1} has an invalid kind`);
    }
    if (request.markerOccurrences !== contract.marker) {
      throw new Error(`Token-budget request ${index + 1} has an invalid marker count`);
    }
    if (request.usageRewritten !== contract.rewritten) {
      throw new Error(`Token-budget request ${index + 1} has an invalid rewrite state`);
    }
    if ('target' in contract) {
      if (request.targetPromptTokens !== contract.target) {
        throw new Error(
          `Token-budget request ${index + 1} has an invalid token target`
        );
      }
    } else if (Object.hasOwn(request, 'targetPromptTokens')) {
      throw new Error(`Token-budget request ${index + 1} must not have a token target`);
    }
  }
}

interface Checkpoint {
  index: number;
  summary: string;
  replacements: NonNullable<ReturnType<typeof parseCompactionReplacementMessages>>;
}

function latestValidCheckpoint(
  events: readonly SessionEvent[]
): Checkpoint | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      !event ||
      event.type !== 'part_created' ||
      event.data.partType !== 'summary' ||
      !isRecord(event.data.payload) ||
      typeof event.data.payload.text !== 'string'
    ) {
      continue;
    }
    const replacements = parseCompactionReplacementMessages(
      event.data.payload.replacementMessages
    );
    if (replacements) {
      return { index, summary: event.data.payload.text, replacements };
    }
  }
  return undefined;
}

function assertNoHandoffInReplacement(checkpoint: Checkpoint): void {
  if (checkpoint.replacements.some(isTokenBudgetHandoffMessage)) {
    throw new Error('Compaction replacement contains a projected handoff marker');
  }
  try {
    assertNoSecrets(checkpoint.replacements, [TOKEN_BUDGET_HANDOFF_TAG]);
  } catch {
    throw new Error('Compaction replacement contains hidden marker text');
  }
}

function assertNoHandoffInSuffix(
  events: readonly SessionEvent[],
  checkpoint: Checkpoint
): void {
  for (const event of events.slice(checkpoint.index + 1)) {
    if (isTokenBudgetHandoffEvent(event)) {
      throw new Error('Effective checkpoint suffix contains a handoff record');
    }
    try {
      assertNoSecrets(event, [TOKEN_BUDGET_HANDOFF_TAG]);
    } catch {
      throw new Error('Effective checkpoint suffix contains hidden marker text');
    }
  }
}

function traceSucceeded(record: DurableToolTraceRecord): boolean {
  return record.output !== null && record.error === null;
}

function requireToolInput(
  record: DurableToolTraceRecord,
  toolName: string
): Record<string, unknown> {
  if (record.toolName !== toolName || !isRecord(record.input)) {
    throw new Error(`Token-budget tool trace expected ${toolName}`);
  }
  return record.input;
}

function assertToolTrace(
  events: readonly SessionEvent[],
  fixture: TokenBudgetHandoffFixture,
  markerIndex: number,
  checkpointIndex: number
): void {
  const trace = extractDurableToolTrace(events);
  if (trace.length !== 3) {
    throw new Error('Token-budget tool trace must contain exactly three calls');
  }
  const failed = trace[0];
  const write = trace[1];
  const passed = trace[2];
  if (!failed || !write || !passed) {
    throw new Error('Token-budget tool trace is incomplete');
  }

  const failedInput = requireToolInput(failed, 'Bash');
  if (
    failedInput.command !== fixture.failingCommand ||
    traceSucceeded(failed) ||
    !failed.error?.includes(fixture.sentinels.failedVerification)
  ) {
    throw new Error('Token-budget first Bash must be the exact failing verification');
  }

  const writeInput = requireToolInput(write, 'Write');
  if (
    writeInput.file_path !== fixture.targetPath ||
    writeInput.content !== fixture.targetContent ||
    !traceSucceeded(write)
  ) {
    throw new Error('Token-budget Write must apply the exact mutation');
  }

  const passedInput = requireToolInput(passed, 'Bash');
  if (passedInput.command !== fixture.passingCommand || !traceSucceeded(passed)) {
    throw new Error('Token-budget final Bash must be the exact passing verification');
  }

  const positions = trace.map((record) => {
    const call = events.findIndex(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_call' &&
        isRecord(event.data.payload) &&
        event.data.payload.toolCallId === record.toolCallId
    );
    const result = events.findIndex(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        isRecord(event.data.payload) &&
        event.data.payload.toolCallId === record.toolCallId
    );
    return { call, result };
  });
  const failedPosition = positions[0];
  const writePosition = positions[1];
  const passedPosition = positions[2];
  if (
    !failedPosition ||
    !writePosition ||
    !passedPosition ||
    failedPosition.call < 0 ||
    failedPosition.result >= markerIndex ||
    writePosition.call <= markerIndex ||
    writePosition.result >= checkpointIndex ||
    passedPosition.call <= checkpointIndex ||
    passedPosition.result < passedPosition.call
  ) {
    throw new Error('Token-budget tool calls crossed a required model boundary');
  }
}

export function assertTokenBudgetTranscript(
  events: readonly SessionEvent[],
  fixture: TokenBudgetHandoffFixture
): void {
  const handoffEvents = events.filter(isTokenBudgetHandoffEvent);
  const validHandoffs = events.flatMap((event) => {
    const parsed = parseTokenBudgetHandoffEvent(event);
    return parsed ? [parsed] : [];
  });
  if (handoffEvents.length !== 1 || validHandoffs.length !== 1) {
    throw new Error('Token-budget transcript must contain exactly one v1 marker');
  }

  const marker = validHandoffs[0];
  if (!marker) {
    throw new Error('Token-budget transcript must contain exactly one v1 marker');
  }
  const markerIndex = events.findIndex(
    (event) => event.id === marker.id && event.type === marker.type
  );
  if (markerIndex < 0) {
    throw new Error('Token-budget transcript marker identity is missing');
  }
  const projected = projectTokenBudgetHandoffEvent(marker);
  if (!projected || !isTokenBudgetHandoffMessage(projected)) {
    throw new Error('Token-budget transcript marker projection is invalid');
  }

  const checkpoint = latestValidCheckpoint(events);
  if (!checkpoint || checkpoint.index <= markerIndex) {
    throw new Error('Latest valid compaction checkpoint must follow the v1 marker');
  }
  assertNoHandoffInReplacement(checkpoint);
  assertNoHandoffInSuffix(events, checkpoint);
  assertContinuationLedger(
    parseContinuationLedger(checkpoint.summary),
    fixture.sentinels
  );
  assertToolTrace(events, fixture, markerIndex, checkpoint.index);

  if (readFileSync(fixture.targetPath, 'utf8') !== fixture.targetContent) {
    throw new Error(
      'Token-budget final file content does not match the exact mutation'
    );
  }
}

export function assertTokenBudgetEvidenceSafe(
  evidence: unknown,
  secrets: readonly string[]
): void {
  assertNoSecrets(evidence, secrets);
  try {
    assertNoSecrets(evidence, [TOKEN_BUDGET_HANDOFF_TAG, HIDDEN_HANDOFF_EVENT_TYPE]);
  } catch (error) {
    throw new Error('Token-budget evidence contains a hidden marker structure', {
      cause: error,
    });
  }
}

export class BoundedStringSink extends EventEmitter {
  readonly #maxChars: number;
  readonly #decoder = new StringDecoder('utf8');
  #tail = '';
  #closed = false;

  constructor(maxChars: number) {
    super();
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new Error('Bounded string sink maximum must be a positive safe integer');
    }
    this.#maxChars = maxChars;
  }

  write(chunk: string | Buffer): boolean {
    if (this.#closed) return false;
    const text = this.#decoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    );
    this.#tail = `${this.#tail}${text}`.slice(-this.#maxChars);
    return true;
  }

  value(): string {
    return this.#tail;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#tail = `${this.#tail}${this.#decoder.end()}`.slice(-this.#maxChars);
    this.removeAllListeners();
  }
}

function assertRecovery(recovery: TokenBudgetHandoffSurfaceEvidence['recovery']): void {
  if (!recovery.completed) {
    throw new Error('Token-budget surface recovery did not complete');
  }
  if (
    !Number.isSafeInteger(recovery.providerRequestsBefore) ||
    recovery.providerRequestsBefore < 0 ||
    !Number.isSafeInteger(recovery.providerRequestsAfter) ||
    recovery.providerRequestsAfter < 0
  ) {
    throw new Error('Token-budget surface recovery request counts are invalid');
  }
  if (recovery.providerRequestsBefore !== recovery.providerRequestsAfter) {
    throw new Error('Token-budget surface recovery issued a Provider request');
  }
}

export function assertAndProjectSurfaceEvidence(input: {
  surface: TokenBudgetHandoffSurfaceEvidence['surface'];
  sessionId: string;
  exitCode: number;
  output: string;
  stderr: string;
  expected: string;
  forbidden: readonly string[];
  recovery: TokenBudgetHandoffSurfaceEvidence['recovery'];
}): TokenBudgetHandoffSurfaceEvidence {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) {
    throw new Error('Token-budget surface session identity is invalid');
  }
  if (input.exitCode !== 0) {
    throw new Error(
      `Token-budget surface exit code must be zero, got ${input.exitCode}`
    );
  }
  for (const forbidden of input.forbidden) {
    if (
      forbidden &&
      (input.output.includes(forbidden) || input.stderr.includes(forbidden))
    ) {
      throw new Error('Token-budget surface output contains a forbidden hidden marker');
    }
  }
  if (input.output.trim() !== input.expected) {
    throw new Error('Token-budget surface output did not match the exact final marker');
  }
  if (input.stderr !== '') {
    throw new Error('Token-budget surface stderr must be exactly empty');
  }
  assertRecovery(input.recovery);

  return {
    surface: input.surface,
    sessionId: input.sessionId,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    recovery: {
      kind: input.recovery.kind,
      completed: input.recovery.completed,
      providerRequestsBefore: input.recovery.providerRequestsBefore,
      providerRequestsAfter: input.recovery.providerRequestsAfter,
    },
    faults: [],
  };
}
