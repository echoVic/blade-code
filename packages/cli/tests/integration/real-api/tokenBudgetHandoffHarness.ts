import { createHash } from 'node:crypto';
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
  finalAssistantText,
} from './sessionForkTrajectoryHarness.js';
import {
  renderTokenBudgetExactNextAction,
  type TokenBudgetHandoffFixture,
} from './tokenBudgetHandoffFixture.js';

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

function diagnosticByteSize(
  bytes: number | undefined
): 0 | '1_4096' | '4097_16384' | '16385_plus' {
  if (!bytes) return 0;
  if (bytes <= 4_096) return '1_4096';
  if (bytes <= 16_384) return '4097_16384';
  return '16385_plus';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatTokenBudgetTranscriptDiagnostic(input: {
  events: readonly SessionEvent[];
  expectedFinal: string;
  surfaceFinalSeen: boolean;
}): string {
  const calls = new Map<string, 'Bash' | 'Write' | 'Other'>();
  let bashCalls = 0;
  let bashSuccesses = 0;
  let writeCalls = 0;
  let writeSuccesses = 0;
  let otherCalls = 0;
  let completeResults = 0;
  let checkpoints = 0;

  for (const event of input.events) {
    if (event.type !== 'part_created') continue;
    if (event.data.partType === 'summary') {
      checkpoints += 1;
      continue;
    }
    if (!isRecord(event.data.payload)) continue;
    const payload = event.data.payload;
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') continue;

    if (event.data.partType === 'tool_call') {
      const kind =
        toolName === 'Bash' ? 'Bash' : toolName === 'Write' ? 'Write' : 'Other';
      calls.set(toolCallId, kind);
      if (kind === 'Bash') bashCalls += 1;
      else if (kind === 'Write') writeCalls += 1;
      else otherCalls += 1;
      continue;
    }
    if (event.data.partType !== 'tool_result') continue;
    const kind = calls.get(toolCallId);
    if (!kind) continue;
    completeResults += 1;
    const succeeded = payload.error === null && payload.output !== null;
    if (succeeded && kind === 'Bash') bashSuccesses += 1;
    if (succeeded && kind === 'Write') writeSuccesses += 1;
  }

  const final = finalAssistantText(input.events);
  const finalPresent = Boolean(final?.trim());
  return JSON.stringify({
    tools: {
      bashCalls,
      bashSuccesses,
      writeCalls,
      writeSuccesses,
      otherCalls,
      completeResults,
    },
    lifecycle: {
      checkpoints,
      turnCompleted: input.events.filter((event) => event.type === 'turn_completed')
        .length,
      turnAborted: input.events.filter((event) => event.type === 'turn_aborted').length,
      surfaceFinalSeen: input.surfaceFinalSeen,
    },
    final: {
      present: finalPresent,
      expectedMarkerPresent: final === input.expectedFinal,
      utf8ByteSizeBucket: diagnosticByteSize(
        finalPresent && final ? Buffer.byteLength(final, 'utf8') : undefined
      ),
      sha256Prefix:
        finalPresent && final
          ? createHash('sha256').update(final).digest('hex').slice(0, 12)
          : null,
    },
  });
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

function requireCanonicalStatusClause(
  sections: Record<string, string>,
  section: LedgerSectionKey,
  sentinel: string,
  status: 'applied' | 'failed' | 'pending',
  label: string
): void {
  const expected = `${sentinel} status=${status}`;
  const authorities = LEDGER_SECTION_KEYS.flatMap((key) =>
    (sections[key] ?? '')
      .split(/\r?\n/)
      .filter((clause) => clause.includes(sentinel))
      .filter((clause) => clauseAssignsExecutionStatus(clause, sentinel))
      .map((clause) => ({ section: key, clause }))
  );
  const canonical = authorities.filter(
    (authority) => authority.section === section && authority.clause === expected
  );
  const extras = authorities.filter(
    (authority) => authority.section !== section || authority.clause !== expected
  );
  const deferredContradiction =
    canonical.length === 1 &&
    extras.length > 0 &&
    extras.every((authority) =>
      status === 'pending'
        ? sentinelHasExplicitStatus(
            { [authority.section]: authority.clause },
            sentinel,
            ['applied', 'complete', 'completed', 'done', 'finished', 'resolved']
          )
        : status === 'failed'
          ? sentinelHasExplicitStatus(
              { [authority.section]: authority.clause },
              sentinel,
              ['pass', 'passed', 'passing', 'success', 'succeeded', 'successful']
            )
          : false
    );
  if (!deferredContradiction && (authorities.length !== 1 || canonical.length !== 1)) {
    throw new Error(
      `Continuation ledger ${label} must use one canonical status clause; ` +
        canonicalStatusClauseDiagnostic(sections[section] ?? '', sentinel, status) +
        `;global_authorities=${authorities.length}`
    );
  }
}

function assertExactNextAction(
  sections: Record<string, string>,
  fixture: TokenBudgetHandoffFixture
): void {
  const expected = renderTokenBudgetExactNextAction({
    command: fixture.passingCommand,
    finalMarker: fixture.finalMarker,
  });
  const matches = (sections.exactNextAction ?? '')
    .split(/\r?\n/)
    .filter((line) => line === expected);
  if (matches.length !== 1) {
    throw new Error(
      'Continuation ledger must preserve one exact executable next action'
    );
  }
}

export function canonicalStatusClauseDiagnostic(
  section: string,
  sentinel: string,
  status: 'applied' | 'failed' | 'pending'
): string {
  const clauses = section.split(/\r?\n/).filter((clause) => clause.includes(sentinel));
  const expected = `${sentinel} status=${status}`;
  const canonical = clauses.filter((clause) => clause === expected).length;
  const starts = clauses.filter((clause) => clause.startsWith(sentinel)).length;
  const withStatus = clauses.filter((clause) =>
    clause.includes(`status=${status}`)
  ).length;
  const extra = clauses.filter((clause) => clause !== expected).length;
  const expectedPrefix = `${sentinel} status=${status}`;
  const suffixes = clauses
    .filter((clause) => clause.startsWith(expectedPrefix))
    .map((clause) => clause.slice(expectedPrefix.length).trim());
  const suffixNone = suffixes.filter((suffix) => suffix.length === 0).length;
  const punctuation = suffixes.filter((suffix) => /^[.,;:!?]+$/.test(suffix)).length;
  const parenthetical = suffixes.filter((suffix) =>
    /^\([^\r\n]*\)[.,;:!?]?$/.test(suffix)
  ).length;
  const prose = suffixes.filter(
    (suffix) =>
      suffix.length > 0 &&
      !/^[.,;:!?]+$/.test(suffix) &&
      !/^\([^\r\n]*\)[.,;:!?]?$/.test(suffix)
  ).length;
  const maximumSuffixLength = suffixes.reduce(
    (maximum, suffix) => Math.max(maximum, suffix.length),
    0
  );
  const maximumSuffixBucket =
    maximumSuffixLength === 0
      ? '0'
      : maximumSuffixLength <= 8
        ? '1_8'
        : maximumSuffixLength <= 32
          ? '9_32'
          : 'overflow';
  return (
    `occurrences=${clauses.length};canonical=${canonical};` +
    `starts=${starts};status=${withStatus};extra=${extra};` +
    `suffix_none=${suffixNone};punctuation=${punctuation};` +
    `parenthetical=${parenthetical};prose=${prose};` +
    `max_suffix=${maximumSuffixBucket}`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clauseAssignsExecutionStatus(clause: string, sentinel: string): boolean {
  const sentinelIndex = clause.indexOf(sentinel);
  if (sentinelIndex < 0) return false;
  if (clause.indexOf(sentinel, sentinelIndex + sentinel.length) >= 0) return true;

  const decoration = /^[`*_~\s]+|[`*_~\s]+$/g;
  const before = clause.slice(0, sentinelIndex).replace(decoration, '').trim();
  const after = clause
    .slice(sentinelIndex + sentinel.length)
    .replace(decoration, '')
    .trim();
  const statusWord =
    '(?:applied|fail|failed|pending|complete|completed|done|finished|resolved|' +
    'pass|passed|passing|success|succeeded|successful)';
  if (
    /^status\s*=/i.test(after) ||
    new RegExp(
      '^(?:is|was|now|did)\\s+(?:not\\s+)?' + statusWord + '(?:\\b|[-_])',
      'i'
    ).test(after) ||
    /\b(?:applied|fail|failed|pending|complete|completed|done|finished|resolved|pass|passed|passing|success|succeeded|successful)\s*$/i.test(
      before
    )
  ) {
    return true;
  }
  return /^(?:applied|fail|failed|pending|complete|completed|done|finished|resolved|pass|passed|passing|success|succeeded|successful)(?:\b|[-_])/i.test(
    after
  );
}

function sentinelHasExplicitStatus(
  sections: Record<string, string>,
  sentinel: string,
  statuses: readonly string[]
): boolean {
  const escapedSentinel = escapeRegExp(sentinel);
  const alternatives = statuses.map(escapeRegExp).join('|');
  const statusBefore = new RegExp(
    `^(?:${alternatives})\\s+${escapedSentinel}(?=\\s|[.,;:!?]|$)`,
    'i'
  );
  const statusAfter = new RegExp(
    `(?:^|\\s)${escapedSentinel}\\s+(?:(?:is|was|now)\\s+)?` +
      `(?:${alternatives})(?=\\s|[.,;:!?]|$)`,
    'i'
  );
  const assigned = new RegExp(
    `(?:^|\\s)${escapedSentinel}\\s+status\\s*=\\s*` +
      `(?:${alternatives})(?=\\s|[.,;:!?]|$)`,
    'i'
  );

  return LEDGER_SECTION_KEYS.some((key) =>
    (sections[key] ?? '')
      .split(/\r?\n/)
      .some((clause) =>
        clause.includes(sentinel)
          ? statusBefore.test(clause) ||
            statusAfter.test(clause) ||
            assigned.test(clause)
          : false
      )
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
  requireCanonicalStatusClause(
    sections,
    'workspaceMutations',
    sentinels.mutation,
    'applied',
    'mutation'
  );
  requireSentinel(
    sections,
    'verificationEvidence',
    sentinels.failedVerification,
    'failed verification'
  );
  requireCanonicalStatusClause(
    sections,
    'verificationEvidence',
    sentinels.failedVerification,
    'failed',
    'failed verification'
  );
  requireSentinel(
    sections,
    'exactNextAction',
    sentinels.pendingAction,
    'pending action'
  );
  requireCanonicalStatusClause(
    sections,
    'exactNextAction',
    sentinels.pendingAction,
    'pending',
    'pending action'
  );
  if (
    sentinelHasExplicitStatus(sections, sentinels.pendingAction, [
      'applied',
      'complete',
      'completed',
      'done',
      'finished',
      'resolved',
    ])
  ) {
    throw new Error('Continuation ledger pending action is marked completed');
  }
  if (
    sentinelHasExplicitStatus(sections, sentinels.failedVerification, [
      'pass',
      'passed',
      'passing',
      'success',
      'succeeded',
      'successful',
    ])
  ) {
    throw new Error('Continuation ledger failed verification is marked passing');
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
  targets: { handoffPromptTokens: number; compactionPromptTokens: number },
  options: {
    expectCompactionRetry?: boolean;
    expectCompactionStepDown?: boolean;
    expectCompactionFallback?: boolean;
  } = {}
): void {
  if (evidence.maxInFlight !== 1) {
    throw new Error('Token-budget Provider requests must have maxInFlight equal to 1');
  }
  const compactionRequestCount = options.expectCompactionStepDown
    ? 3
    : options.expectCompactionRetry
      ? 2
      : 1;
  const minimumRequests = 4 + compactionRequestCount;
  const maximumRequests = 8 + compactionRequestCount;
  if (
    evidence.requests.length < minimumRequests ||
    evidence.requests.length > maximumRequests
  ) {
    const sequence = evidence.requests
      .map(
        (request) =>
          `${request.ordinal}:${request.kind}:m${request.markerOccurrences}:` +
          `r${request.usageRewritten ? 1 : 0}:s${request.upstreamStatus ?? 0}:` +
          `k${request.responseKind ?? 'unknown'}:` +
          `u${request.usageShape ?? 'unknown'}`
      )
      .join(',');
    throw new Error(
      `Token-budget Provider evidence must contain ${minimumRequests} to ` +
        `${maximumRequests} requests; ` +
        `count=${evidence.requests.length}; sequence=${sequence}`
    );
  }

  const expected: Array<{
    kind: 'task' | 'compaction';
    marker: number;
    rewritten: boolean;
    target?: number;
    status?: number;
    injectedFailure?: 'compaction_context_overflow' | 'compaction_transient';
  }> = [
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
    ...(options.expectCompactionStepDown
      ? [
          {
            kind: 'compaction' as const,
            marker: 0,
            rewritten: false,
            status: 400,
            injectedFailure: 'compaction_context_overflow' as const,
          },
          {
            kind: 'compaction' as const,
            marker: 0,
            rewritten: false,
            status: 503,
            injectedFailure: 'compaction_transient' as const,
          },
          {
            kind: 'compaction' as const,
            marker: 0,
            rewritten: false,
            status: options.expectCompactionFallback ? 503 : 200,
            ...(options.expectCompactionFallback
              ? {
                  injectedFailure: 'compaction_transient' as const,
                }
              : {}),
          },
        ]
      : options.expectCompactionRetry
        ? [
            {
              kind: 'compaction' as const,
              marker: 0,
              rewritten: false,
              status: 503,
              injectedFailure: 'compaction_transient' as const,
            },
            {
              kind: 'compaction' as const,
              marker: 0,
              rewritten: false,
              status: 200,
            },
          ]
        : [
            {
              kind: 'compaction' as const,
              marker: 0,
              rewritten: false,
            },
          ]),
    { kind: 'task', marker: 0, rewritten: false },
    { kind: 'task', marker: 0, rewritten: false },
  ];

  for (const [index, request] of evidence.requests.entries()) {
    assertRequestShape(request, index);
    const contract = expected[index];
    if (!contract) {
      if (
        request.kind !== 'task' ||
        request.markerOccurrences !== 0 ||
        request.usageRewritten ||
        Object.hasOwn(request, 'targetPromptTokens')
      ) {
        throw new Error(
          `Token-budget corrective request ${index + 1} has an invalid shape`
        );
      }
      continue;
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
    if (contract.target !== undefined) {
      if (request.targetPromptTokens !== contract.target) {
        throw new Error(
          `Token-budget request ${index + 1} has an invalid token target`
        );
      }
    } else if (Object.hasOwn(request, 'targetPromptTokens')) {
      throw new Error(`Token-budget request ${index + 1} must not have a token target`);
    }
    if (contract.status !== undefined && request.upstreamStatus !== contract.status) {
      throw new Error(`Token-budget request ${index + 1} has an invalid status`);
    }
    if (request.injectedFailure !== contract.injectedFailure) {
      throw new Error(
        `Token-budget request ${index + 1} has an invalid injected failure`
      );
    }
  }
  if (options.expectCompactionStepDown) {
    const firstCompaction = evidence.requests[2];
    const reducedCompaction = evidence.requests[3];
    if (
      !firstCompaction ||
      !reducedCompaction ||
      firstCompaction.bodySha256 === reducedCompaction.bodySha256 ||
      reducedCompaction.bodyBytes >= firstCompaction.bodyBytes
    ) {
      throw new Error(
        'Token-budget compaction retry did not prove a smaller changed payload'
      );
    }
  }
}

export function assertTokenBudgetRequestSequenceWithTranscript(input: {
  evidence: TokenBudgetProxyEvidence;
  targets: { handoffPromptTokens: number; compactionPromptTokens: number };
  events: readonly SessionEvent[];
  expectedFinal: string;
  surfaceFinalSeen: boolean;
  expectCompactionRetry?: boolean;
  expectCompactionStepDown?: boolean;
  expectCompactionFallback?: boolean;
}): void {
  try {
    assertTokenBudgetRequestSequence(input.evidence, input.targets, {
      expectCompactionRetry: input.expectCompactionRetry,
      expectCompactionStepDown: input.expectCompactionStepDown,
      expectCompactionFallback: input.expectCompactionFallback,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Token-budget Provider request sequence validation failed';
    const diagnostic = formatTokenBudgetTranscriptDiagnostic({
      events: input.events,
      expectedFinal: input.expectedFinal,
      surfaceFinalSeen: input.surfaceFinalSeen,
    });
    throw new Error(`${message}; transcript=${diagnostic}`);
  }
}

interface Checkpoint {
  index: number;
  summary: string;
  replacements: NonNullable<ReturnType<typeof parseCompactionReplacementMessages>>;
  strategy?: string;
  postTokens?: number;
  sampleAttempts?: number;
  inputReductions?: number;
  messagesOmitted?: number;
  filesOmitted?: number;
  imagesOmitted?: number;
  fallbackTargetTokens?: number;
  fallbackMessagesOmitted?: number;
  fallbackMessagesTruncated?: number;
  failureReason?: string;
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
      const metadata = event.data.payload.metadata;
      return {
        index,
        summary: event.data.payload.text,
        replacements,
        ...(isRecord(metadata) && typeof metadata.strategy === 'string'
          ? { strategy: metadata.strategy }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.postTokens === 'number' &&
        Number.isSafeInteger(metadata.postTokens)
          ? { postTokens: metadata.postTokens }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.sampleAttempts === 'number' &&
        Number.isSafeInteger(metadata.sampleAttempts)
          ? { sampleAttempts: metadata.sampleAttempts }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.inputReductions === 'number' &&
        Number.isSafeInteger(metadata.inputReductions)
          ? { inputReductions: metadata.inputReductions }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.messagesOmitted === 'number' &&
        Number.isSafeInteger(metadata.messagesOmitted)
          ? { messagesOmitted: metadata.messagesOmitted }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.filesOmitted === 'number' &&
        Number.isSafeInteger(metadata.filesOmitted)
          ? { filesOmitted: metadata.filesOmitted }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.imagesOmitted === 'number' &&
        Number.isSafeInteger(metadata.imagesOmitted)
          ? { imagesOmitted: metadata.imagesOmitted }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.fallbackTargetTokens === 'number' &&
        Number.isSafeInteger(metadata.fallbackTargetTokens)
          ? { fallbackTargetTokens: metadata.fallbackTargetTokens }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.fallbackMessagesOmitted === 'number' &&
        Number.isSafeInteger(metadata.fallbackMessagesOmitted)
          ? { fallbackMessagesOmitted: metadata.fallbackMessagesOmitted }
          : {}),
        ...(isRecord(metadata) &&
        typeof metadata.fallbackMessagesTruncated === 'number' &&
        Number.isSafeInteger(metadata.fallbackMessagesTruncated)
          ? {
              fallbackMessagesTruncated: metadata.fallbackMessagesTruncated,
            }
          : {}),
        ...(isRecord(metadata) && typeof metadata.failureReason === 'string'
          ? { failureReason: metadata.failureReason }
          : {}),
      };
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
  if (trace.length < 3 || trace.length > 8) {
    throw new Error('Token-budget tool trace must contain three to eight calls');
  }

  const positioned = trace.map((record) => {
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
    if (call < 0 || result < call) {
      throw new Error('Token-budget tool trace contains an incomplete call');
    }
    if (record.toolName === 'Bash') {
      const input = requireToolInput(record, 'Bash');
      if (input.command !== fixture.passingCommand) {
        throw new Error('Token-budget Bash must use the exact verification command');
      }
    } else if (record.toolName === 'Write') {
      const input = requireToolInput(record, 'Write');
      if (
        input.file_path !== fixture.targetPath ||
        input.content !== fixture.targetContent
      ) {
        throw new Error('Token-budget Write must apply the exact mutation');
      }
    } else {
      throw new Error('Token-budget tool trace contains an unexpected tool');
    }
    return { record, call, result };
  });

  const failedPosition = positioned.find(
    ({ record, result }) =>
      record.toolName === 'Bash' &&
      !traceSucceeded(record) &&
      record.error?.includes(fixture.sentinels.failedVerification) &&
      result < markerIndex
  );
  const writePosition = positioned.find(
    ({ record, call, result }) =>
      record.toolName === 'Write' &&
      traceSucceeded(record) &&
      call > markerIndex &&
      result < checkpointIndex
  );
  const passedPosition = positioned.find(
    ({ record, call }) =>
      record.toolName === 'Bash' && traceSucceeded(record) && call > checkpointIndex
  );
  if (
    !failedPosition ||
    !writePosition ||
    !passedPosition ||
    positioned.filter(({ result }) => result < markerIndex).length !== 1
  ) {
    throw new Error('Token-budget tool calls crossed a required model boundary');
  }
}

export function assertTokenBudgetTranscript(
  events: readonly SessionEvent[],
  fixture: TokenBudgetHandoffFixture,
  options: {
    expectedSampleAttempts?: number;
    expectedInputReductions?: number;
    expectCompactionFallback?: boolean;
  } = {}
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
  if (
    options.expectedSampleAttempts !== undefined &&
    checkpoint.sampleAttempts !== options.expectedSampleAttempts
  ) {
    throw new Error(
      'Compaction checkpoint does not prove the expected recovered sample attempts'
    );
  }
  if (
    options.expectedInputReductions !== undefined &&
    (checkpoint.inputReductions !== options.expectedInputReductions ||
      (checkpoint.messagesOmitted ?? 0) + (checkpoint.filesOmitted ?? 0) < 1)
  ) {
    throw new Error(
      `Compaction checkpoint does not prove the expected input reduction: ${JSON.stringify(
        {
          inputReductions: checkpoint.inputReductions,
          messagesOmitted: checkpoint.messagesOmitted,
          filesOmitted: checkpoint.filesOmitted,
          imagesOmitted: checkpoint.imagesOmitted,
          failureReason: checkpoint.failureReason,
        }
      )}`
    );
  }
  if (options.expectCompactionFallback) {
    if (
      checkpoint.strategy !== 'fallback' ||
      checkpoint.failureReason !== 'transient_exhausted' ||
      checkpoint.postTokens === undefined ||
      checkpoint.fallbackTargetTokens === undefined ||
      checkpoint.fallbackTargetTokens <= 0 ||
      checkpoint.postTokens > checkpoint.fallbackTargetTokens ||
      checkpoint.fallbackMessagesOmitted === undefined ||
      checkpoint.fallbackMessagesOmitted < 0 ||
      checkpoint.fallbackMessagesTruncated === undefined ||
      checkpoint.fallbackMessagesTruncated < 0
    ) {
      throw new Error(
        `Compaction checkpoint does not prove bounded fallback: ${JSON.stringify({
          strategy: checkpoint.strategy,
          postTokens: checkpoint.postTokens,
          fallbackTargetTokens: checkpoint.fallbackTargetTokens,
          fallbackMessagesOmitted: checkpoint.fallbackMessagesOmitted,
          fallbackMessagesTruncated: checkpoint.fallbackMessagesTruncated,
          failureReason: checkpoint.failureReason,
        })}`
      );
    }
  } else if (checkpoint.failureReason !== undefined) {
    throw new Error('Recovered compaction checkpoint has a failure reason');
  }
  assertNoHandoffInReplacement(checkpoint);
  assertNoHandoffInSuffix(events, checkpoint);
  const ledger = parseContinuationLedger(checkpoint.summary);
  assertContinuationLedger(ledger, fixture.sentinels);
  assertExactNextAction(ledger, fixture);
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
