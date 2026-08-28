import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../src/context/types.js';
import { finalAssistantText } from '../integration/real-api/sessionForkTrajectoryHarness.js';

const INPUT_ENV = 'BLADE_DURABLE_INTERACTION_ACP_INPUT';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const MAX_SURFACE_TEXT_CHARS = 256 * 1024;
const MAX_DURABLE_EVENTS = 4_096;
const MAX_DURABLE_SERIALIZED_BYTES = 1024 * 1024;
const NORMAL_CLOSE_TIMEOUT_MS = 15_000;
const FALLBACK_TERM_TIMEOUT_MS = 5_000;
const FALLBACK_KILL_TIMEOUT_MS = 5_000;

export interface DurableInteractionRecoveryAcpRunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  requestId: string;
  targetPath: string;
  answerLabel: string;
  expectedContent: string;
  finalMarker: string;
  secret: string;
  timeoutMs: number;
}

export interface DurableInteractionRecoveryAcpEvidence {
  success: true;
  sessionId: string;
  modeId: string;
  questionRequests: 1;
  requestMatched: true;
  optionMatched: true;
  interactionRequested: 1;
  interactionResponded: 1;
  interactionRecovered: 1;
  recoveryToolResults: 1;
  writeCalls: 1;
  writeResults: 1;
  inboxMissing: true;
  acpFinalMarkerCount: 1;
  durableFinalMarkerCount: 1;
  targetSha256: string;
  targetBytes: number;
  sessionClosed: true;
  eofClosed: true;
  childExitCode: 0;
  childExitSignal: null;
  termFallbackUsed: false;
  killFallbackUsed: false;
  secretSeen: false;
}

type RunnerStage =
  | 'input'
  | 'spawn'
  | 'initialize'
  | 'load_session'
  | 'recovery'
  | 'close_session'
  | 'eof'
  | 'child_exit'
  | 'evidence';

export interface DurableInteractionRecoveryAcpFailureEvidence {
  success: false;
  stage: RunnerStage;
  code:
    | 'invalid_input'
    | 'spawn_failed'
    | 'protocol_failed'
    | 'timeout'
    | 'surface_secret'
    | 'invalid_recovery'
    | 'cleanup_failed';
  timedOut: boolean;
  secretSeen: boolean;
  termFallbackUsed: boolean;
  killFallbackUsed: boolean;
}

export type RunnerEvidence =
  | DurableInteractionRecoveryAcpEvidence
  | DurableInteractionRecoveryAcpFailureEvidence;

interface CompletionFacts {
  interactionRequested: 1;
  interactionResponded: 1;
  interactionRecovered: 1;
  recoveryToolResults: 1;
  writeCalls: 1;
  writeResults: 1;
  inboxMissing: true;
  acpFinalMarkerCount: 1;
  durableFinalMarkerCount: 1;
  targetSha256: string;
  targetBytes: number;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class RunnerTimeoutError extends Error {}
class InvalidRecoveryError extends Error {}
class SurfaceSecretError extends Error {}

interface DurableCompletionLifecycle {
  turnId: string;
  started: Extract<SessionEvent, { type: 'turn_started' }>;
  acknowledged: Extract<SessionEvent, { type: 'inbox_acknowledged' }>;
  completed: Extract<SessionEvent, { type: 'turn_completed' }>;
}

interface PollDurableInteractionCompletionOptions<T> {
  deadlineAt: number;
  inspect: () => Promise<T | undefined>;
  assertActive?: () => void;
  intervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(value)
  );
}

function decodeCanonicalBase64(encoded: string): string {
  if (
    !encoded ||
    Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Durable interaction ACP runner input is invalid');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length > MAX_INPUT_BYTES || decoded.toString('base64') !== encoded) {
    throw new Error('Durable interaction ACP runner input is invalid');
  }
  return decoded.toString('utf8');
}

export function parseDurableInteractionRecoveryAcpRunnerInput(
  encoded: string
): DurableInteractionRecoveryAcpRunnerInput {
  let serialized: string;
  let parsed: unknown;
  try {
    serialized = decodeCanonicalBase64(encoded);
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Durable interaction ACP runner input is invalid');
  }
  const keys = [
    'answerLabel',
    'cliEntry',
    'expectedContent',
    'finalMarker',
    'home',
    'requestId',
    'secret',
    'sessionId',
    'storageRoot',
    'targetPath',
    'timeoutMs',
    'workspace',
  ] as const;
  if (
    JSON.stringify(parsed) !== serialized ||
    !isRecord(parsed) ||
    !hasExactKeys(parsed, keys) ||
    !isNonemptyString(parsed.cliEntry) ||
    !isNonemptyString(parsed.workspace) ||
    !isNonemptyString(parsed.home) ||
    !isNonemptyString(parsed.storageRoot) ||
    !isValidSessionId(parsed.sessionId) ||
    !isNonemptyString(parsed.requestId) ||
    !isNonemptyString(parsed.targetPath) ||
    !isNonemptyString(parsed.answerLabel) ||
    !isNonemptyString(parsed.expectedContent) ||
    !isNonemptyString(parsed.finalMarker) ||
    !isNonemptyString(parsed.secret) ||
    !Number.isSafeInteger(parsed.timeoutMs) ||
    Number(parsed.timeoutMs) <= 0 ||
    Number(parsed.timeoutMs) > 600_000 ||
    !path.isAbsolute(parsed.cliEntry) ||
    !path.isAbsolute(parsed.workspace) ||
    !path.isAbsolute(parsed.home) ||
    !path.isAbsolute(parsed.storageRoot) ||
    !path.isAbsolute(parsed.targetPath)
  ) {
    throw new Error('Durable interaction ACP runner input is invalid');
  }
  const cliEntry = path.resolve(parsed.cliEntry);
  const workspace = path.resolve(parsed.workspace);
  const targetPath = path.resolve(parsed.targetPath);
  const relativeTarget = path.relative(workspace, targetPath);
  if (
    !cliEntry.replaceAll('\\', '/').endsWith('/dist/blade.js') ||
    relativeTarget === '..' ||
    relativeTarget.startsWith('../') ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error('Durable interaction ACP runner input is invalid');
  }
  return {
    cliEntry,
    workspace,
    home: path.resolve(parsed.home),
    storageRoot: path.resolve(parsed.storageRoot),
    sessionId: parsed.sessionId,
    requestId: parsed.requestId,
    targetPath,
    answerLabel: parsed.answerLabel,
    expectedContent: parsed.expectedContent,
    finalMarker: parsed.finalMarker,
    secret: parsed.secret,
    timeoutMs: Number(parsed.timeoutMs),
  };
}

const EVIDENCE_KEYS = [
  'acpFinalMarkerCount',
  'childExitCode',
  'childExitSignal',
  'durableFinalMarkerCount',
  'eofClosed',
  'inboxMissing',
  'interactionRecovered',
  'interactionRequested',
  'interactionResponded',
  'killFallbackUsed',
  'modeId',
  'optionMatched',
  'questionRequests',
  'recoveryToolResults',
  'requestMatched',
  'secretSeen',
  'sessionClosed',
  'sessionId',
  'success',
  'targetBytes',
  'targetSha256',
  'termFallbackUsed',
  'writeCalls',
  'writeResults',
] as const;

export function parseDurableInteractionRecoveryAcpEvidence(
  stdout: string,
  secret: string
): DurableInteractionRecoveryAcpEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new Error('Durable interaction ACP evidence exceeded its serialized budget');
  }
  if (secret && stdout.includes(secret)) {
    throw new Error('Durable interaction ACP evidence contains provider credentials');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Durable interaction ACP evidence is invalid');
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, EVIDENCE_KEYS) ||
    parsed.success !== true ||
    !isValidSessionId(parsed.sessionId) ||
    parsed.modeId !== 'yolo' ||
    parsed.questionRequests !== 1 ||
    parsed.requestMatched !== true ||
    parsed.optionMatched !== true ||
    parsed.interactionRequested !== 1 ||
    parsed.interactionResponded !== 1 ||
    parsed.interactionRecovered !== 1 ||
    parsed.recoveryToolResults !== 1 ||
    parsed.writeCalls !== 1 ||
    parsed.writeResults !== 1 ||
    parsed.inboxMissing !== true ||
    parsed.acpFinalMarkerCount !== 1 ||
    parsed.durableFinalMarkerCount !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(parsed.targetSha256 ?? '')) ||
    !Number.isSafeInteger(parsed.targetBytes) ||
    Number(parsed.targetBytes) <= 0 ||
    parsed.sessionClosed !== true ||
    parsed.eofClosed !== true ||
    parsed.childExitCode !== 0 ||
    parsed.childExitSignal !== null ||
    parsed.termFallbackUsed !== false ||
    parsed.killFallbackUsed !== false ||
    parsed.secretSeen !== false
  ) {
    throw new Error('Durable interaction ACP evidence is invalid');
  }
  return parsed as unknown as DurableInteractionRecoveryAcpEvidence;
}

class SecretScanner {
  private readonly tails = new Map<string, string>();
  seen = false;

  constructor(private readonly secret: string) {}

  observe(channel: string, chunk: string): void {
    if (this.seen || !this.secret || !chunk) return;
    const combined = (this.tails.get(channel) ?? '') + chunk;
    if (combined.includes(this.secret)) {
      this.seen = true;
      return;
    }
    const retainedCharacters = Math.max(0, this.secret.length - 1);
    this.tails.set(
      channel,
      retainedCharacters === 0 ? '' : combined.slice(-retainedCharacters)
    );
  }
}

function jsonStringByteLength(value: string, limit: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function boundedJsonByteLength(
  value: unknown,
  limit: number,
  ancestors = new Set<object>()
): number {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringByteLength(value, limit);
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value).length : 4;
  }
  if (typeof value !== 'object') return 4;
  if (ancestors.has(value)) throw new TypeError('Circular durable event value');

  ancestors.add(value);
  let bytes = 2;
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (index > 0) bytes += 1;
        bytes += boundedJsonByteLength(value[index], limit - bytes, ancestors);
        if (bytes > limit) return bytes;
      }
      return bytes;
    }

    let propertyIndex = 0;
    for (const [key, item] of Object.entries(value)) {
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol'
      ) {
        continue;
      }
      if (propertyIndex > 0) bytes += 1;
      propertyIndex += 1;
      bytes += jsonStringByteLength(key, limit - bytes) + 1;
      bytes += boundedJsonByteLength(item, limit - bytes, ancestors);
      if (bytes > limit) return bytes;
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

function scanDurableEvents(
  events: readonly SessionEvent[],
  observe?: (serializedEvent: string) => void
): void {
  if (events.length > MAX_DURABLE_EVENTS) {
    throw new InvalidRecoveryError('durable event budget exceeded');
  }

  let serializedBytes = 2;
  for (const event of events) {
    if (serializedBytes > MAX_DURABLE_SERIALIZED_BYTES) {
      throw new InvalidRecoveryError('durable event budget exceeded');
    }
    const remaining = MAX_DURABLE_SERIALIZED_BYTES - serializedBytes;
    if (boundedJsonByteLength(event, remaining) > remaining) {
      throw new InvalidRecoveryError('durable event budget exceeded');
    }
    const serializedEvent = JSON.stringify(event);
    serializedBytes += Buffer.byteLength(serializedEvent, 'utf8') + 1;
    if (serializedBytes > MAX_DURABLE_SERIALIZED_BYTES) {
      throw new InvalidRecoveryError('durable event budget exceeded');
    }
    observe?.(serializedEvent);
  }
}

export function inspectDurableCompletionLifecycle(
  events: readonly SessionEvent[],
  inboxMessageId: string,
  observeSerializedEvent?: (serializedEvent: string) => void
): DurableCompletionLifecycle | undefined {
  scanDurableEvents(events, observeSerializedEvent);

  const starts = events.filter(
    (event): event is Extract<SessionEvent, { type: 'turn_started' }> =>
      event.type === 'turn_started' &&
      event.data.inputMessageIds?.filter((id) => id === inboxMessageId).length === 1
  );
  const acknowledgements = events.filter(
    (event): event is Extract<SessionEvent, { type: 'inbox_acknowledged' }> =>
      event.type === 'inbox_acknowledged' &&
      event.data.messageIds.includes(inboxMessageId)
  );
  if (starts.length > 1 || acknowledgements.length > 1) {
    throw new InvalidRecoveryError('duplicate durable completion evidence');
  }
  if (
    acknowledgements.some(
      (event) =>
        event.data.messageIds.filter((id) => id === inboxMessageId).length !== 1
    )
  ) {
    throw new InvalidRecoveryError('duplicate durable completion evidence');
  }
  const started = starts[0];
  if (!started) {
    if (acknowledgements.length > 0) {
      throw new InvalidRecoveryError('durable completion ordering is invalid');
    }
    return undefined;
  }

  const completions = events.filter(
    (event): event is Extract<SessionEvent, { type: 'turn_completed' }> =>
      event.type === 'turn_completed' && event.data.turnId === started.data.turnId
  );
  if (completions.length > 1) {
    throw new InvalidRecoveryError('duplicate durable completion evidence');
  }
  const acknowledged = acknowledgements[0];
  const completed = completions[0];
  if (!acknowledged || !completed) {
    if (completed) {
      throw new InvalidRecoveryError('durable completion ordering is invalid');
    }
    return undefined;
  }
  if (
    !(
      events.indexOf(started) < events.indexOf(acknowledged) &&
      events.indexOf(acknowledged) < events.indexOf(completed)
    )
  ) {
    throw new InvalidRecoveryError('durable completion ordering is invalid');
  }
  return {
    turnId: started.data.turnId,
    started,
    acknowledged,
    completed,
  };
}

function scannedAcpOutput(
  stdout: Readable,
  scanner: SecretScanner
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  return (Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scanner.observe('stdout', decoder.decode(chunk, { stream: true }));
        if (scanner.seen) throw new SurfaceSecretError('surface secret');
        controller.enqueue(chunk);
      },
      flush() {
        scanner.observe('stdout', decoder.decode());
        if (scanner.seen) throw new SurfaceSecretError('surface secret');
      },
    })
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function interactionEvents(
  events: readonly SessionEvent[],
  type: 'interaction_requested' | 'interaction_responded' | 'interaction_recovered',
  requestId: string
): SessionEvent[] {
  return events.filter(
    (event) => event.type === type && event.data.requestId === requestId
  );
}

function payloadRecord(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== 'part_created' || !isRecord(event.data.payload)) return undefined;
  return event.data.payload;
}

interface DurableWriteEvidence {
  call: {
    event: SessionEvent;
    toolCallId: string;
    input: Record<string, unknown>;
  };
  result: {
    event: SessionEvent;
    toolCallId: string;
  };
}

export function inspectDurableWriteEvidence(
  events: readonly SessionEvent[],
  targetPath: string,
  expectedContent: string
): DurableWriteEvidence | undefined {
  const calls = events.flatMap((event) => {
    const payload = payloadRecord(event);
    return event.type === 'part_created' &&
      event.data.partType === 'tool_call' &&
      payload?.toolName === 'Write' &&
      typeof payload.toolCallId === 'string' &&
      isRecord(payload.input)
      ? [{ event, toolCallId: payload.toolCallId, input: payload.input }]
      : [];
  });
  const results = events.flatMap((event) => {
    const payload = payloadRecord(event);
    return event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      payload?.toolName === 'Write' &&
      typeof payload.toolCallId === 'string'
      ? [
          {
            event,
            toolCallId: payload.toolCallId,
            succeeded: payload.error === null && payload.output !== null,
          },
        ]
      : [];
  });
  if (calls.length > 1 || results.length > 1) {
    throw new InvalidRecoveryError('duplicate recovery side effect');
  }
  if (calls.length !== 1 || results.length !== 1) return undefined;

  const call = calls[0]!;
  const result = results[0]!;
  if (
    call.input.file_path !== targetPath ||
    call.input.content !== expectedContent ||
    result.toolCallId !== call.toolCallId ||
    !result.succeeded
  ) {
    throw new InvalidRecoveryError('Write evidence is invalid');
  }
  return { call, result };
}

function responseMatchesAnswer(
  response: unknown,
  header: string,
  expected: string
): boolean {
  if (
    !isRecord(response) ||
    response.approved !== true ||
    !isRecord(response.answers)
  ) {
    return false;
  }
  return (
    Object.keys(response.answers).length === 1 && response.answers[header] === expected
  );
}

function assistantText(events: readonly SessionEvent[]): string {
  const ids = new Set(
    events.flatMap((event) =>
      event.type === 'message_created' && event.data.role === 'assistant'
        ? [event.data.messageId]
        : []
    )
  );
  return events
    .flatMap((event) => {
      const payload = payloadRecord(event);
      return event.type === 'part_created' &&
        event.data.partType === 'text' &&
        ids.has(event.data.messageId) &&
        typeof payload?.text === 'string'
        ? [payload.text]
        : [];
    })
    .join('');
}

function questionDefinition(
  events: readonly SessionEvent[],
  input: DurableInteractionRecoveryAcpRunnerInput
) {
  const allRequests = events.filter((event) => event.type === 'interaction_requested');
  const requests = interactionEvents(events, 'interaction_requested', input.requestId);
  if (allRequests.length !== 1 || requests.length !== 1) {
    throw new InvalidRecoveryError('invalid durable question');
  }
  const request = requests[0];
  if (
    request?.type !== 'interaction_requested' ||
    request.data.interactionType !== 'question' ||
    request.data.toolName !== 'AskUserQuestion' ||
    !isRecord(request.data.details) ||
    request.data.details.type !== 'askUserQuestion' ||
    request.data.details.interactionRequestId !== input.requestId ||
    request.data.details.toolCallId !== request.data.toolCallId ||
    !Array.isArray(request.data.details.questions) ||
    request.data.details.questions.length !== 1
  ) {
    throw new InvalidRecoveryError('invalid durable question');
  }
  const question = request.data.details.questions[0];
  if (
    !isRecord(question) ||
    typeof question.header !== 'string' ||
    typeof question.question !== 'string' ||
    question.multiSelect !== false ||
    !Array.isArray(question.options)
  ) {
    throw new InvalidRecoveryError('invalid durable question');
  }
  const labels = question.options.flatMap((option) =>
    isRecord(option) && typeof option.label === 'string' ? [option.label] : []
  );
  if (
    labels.length !== question.options.length ||
    labels.filter((label) => label === input.answerLabel).length !== 1
  ) {
    throw new InvalidRecoveryError('invalid durable question option');
  }
  return { header: question.header, labels };
}

class DurableInteractionAcpClient implements acp.Client {
  readonly questionRequests: acp.RequestPermissionRequest[] = [];
  requestMatched = false;
  optionMatched = false;
  terminalFailure = false;
  private agentTextValue = '';
  private surfaceOverflow = false;

  constructor(
    private readonly input: DurableInteractionRecoveryAcpRunnerInput,
    private readonly scanner: SecretScanner
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    this.scanner.observe('permission', JSON.stringify(params));
    if (this.scanner.seen) throw new SurfaceSecretError('surface secret');
    this.questionRequests.push(params);
    if (
      this.questionRequests.length !== 1 ||
      params.sessionId !== this.input.sessionId
    ) {
      throw new InvalidRecoveryError('unexpected permission request');
    }
    const events =
      (await new PersistentStore(this.input.workspace).loadEvents(
        this.input.sessionId
      )) ?? [];
    scanDurableEvents(events, (serializedEvent) =>
      this.scanner.observe('durable', serializedEvent)
    );
    if (this.scanner.seen) throw new SurfaceSecretError('surface secret');
    const definition = questionDefinition(events, this.input);
    const expectedNames = [...definition.labels, 'Cancel'];
    if (
      params.toolCall.title !== definition.header ||
      params.options.length !== expectedNames.length ||
      params.options.some(
        (option, index) =>
          option.name !== expectedNames[index] ||
          option.kind !==
            (index === expectedNames.length - 1 ? 'reject_once' : 'allow_once')
      )
    ) {
      throw new InvalidRecoveryError('permission request does not match interaction');
    }
    this.requestMatched = true;
    const matches = params.options.filter(
      (option) => option.name === this.input.answerLabel && option.kind === 'allow_once'
    );
    if (matches.length !== 1) {
      throw new InvalidRecoveryError('question option is not exact');
    }
    this.optionMatched = true;
    return { outcome: { outcome: 'selected', optionId: matches[0]!.optionId } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.scanner.observe('updates', JSON.stringify(params));
    const update = params.update;
    if (
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'user_message_chunk') &&
      update.content.type === 'text'
    ) {
      this.scanner.observe(update.sessionUpdate, update.content.text);
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.agentTextValue += update.content.text;
        if (this.agentTextValue.length > MAX_SURFACE_TEXT_CHARS) {
          this.surfaceOverflow = true;
          this.agentTextValue = this.agentTextValue.slice(-MAX_SURFACE_TEXT_CHARS);
        }
      }
    }
    if (update.sessionUpdate === 'session_info_update') {
      const pending = update._meta?.['blade/pendingResume'];
      if (
        isRecord(pending) &&
        (pending.phase === 'failed' || pending.phase === 'exhausted')
      ) {
        this.terminalFailure = true;
      }
    }
    if (this.scanner.seen) throw new SurfaceSecretError('surface secret');
  }

  agentText(): string {
    return this.agentTextValue;
  }

  overflowed(): boolean {
    return this.surfaceOverflow;
  }
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

async function inspectCompletion(
  input: DurableInteractionRecoveryAcpRunnerInput,
  client: DurableInteractionAcpClient,
  scanner: SecretScanner
): Promise<CompletionFacts | undefined> {
  const events =
    (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
  const inboxMessageId = `interaction-${input.requestId}`;
  const lifecycle = inspectDurableCompletionLifecycle(
    events,
    inboxMessageId,
    (serializedEvent) => scanner.observe('durable', serializedEvent)
  );
  if (scanner.seen) throw new SurfaceSecretError('surface secret');

  const requested = interactionEvents(events, 'interaction_requested', input.requestId);
  const responded = interactionEvents(events, 'interaction_responded', input.requestId);
  const recovered = interactionEvents(events, 'interaction_recovered', input.requestId);
  const allInteractionCounts = {
    requested: events.filter((event) => event.type === 'interaction_requested').length,
    responded: events.filter((event) => event.type === 'interaction_responded').length,
    recovered: events.filter((event) => event.type === 'interaction_recovered').length,
  };
  if (
    allInteractionCounts.requested > 1 ||
    allInteractionCounts.responded > 1 ||
    allInteractionCounts.recovered > 1 ||
    requested.length > 1 ||
    responded.length > 1 ||
    recovered.length > 1
  ) {
    throw new InvalidRecoveryError('duplicate interaction evidence');
  }
  if (requested.length !== 1 || responded.length !== 1 || recovered.length !== 1) {
    return undefined;
  }
  const definition = questionDefinition(events, input);
  const response = responded[0];
  if (
    response?.type !== 'interaction_responded' ||
    !responseMatchesAnswer(response.data.response, definition.header, input.answerLabel)
  ) {
    throw new InvalidRecoveryError('interaction response is invalid');
  }
  const recovery = recovered[0];
  if (recovery?.type !== 'interaction_recovered') {
    throw new InvalidRecoveryError('interaction recovery is invalid');
  }
  const recoveryResults = events.filter((event) => {
    const payload = payloadRecord(event);
    return (
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      payload?.toolName === 'AskUserQuestion' &&
      isRecord(payload.metadata) &&
      payload.metadata.interactionRecovery === true &&
      payload.metadata.requestId === input.requestId
    );
  });
  const write = inspectDurableWriteEvidence(
    events,
    input.targetPath,
    input.expectedContent
  );
  if (recoveryResults.length > 1) {
    throw new InvalidRecoveryError('duplicate recovery side effect');
  }
  if (recoveryResults.length !== 1 || !write) {
    return undefined;
  }
  if (!lifecycle) return undefined;
  const indexOf = (event: SessionEvent | undefined) =>
    event ? events.indexOf(event) : -1;
  if (
    !(
      indexOf(requested[0]) < indexOf(responded[0]) &&
      indexOf(responded[0]) < indexOf(recoveryResults[0]) &&
      indexOf(recoveryResults[0]) < indexOf(recovered[0]) &&
      indexOf(recovered[0]) < indexOf(lifecycle.started) &&
      indexOf(lifecycle.started) < indexOf(write.call.event) &&
      indexOf(write.call.event) < indexOf(write.result.event)
    )
  ) {
    throw new InvalidRecoveryError('durable recovery ordering is invalid');
  }
  if (recovery.data.inboxMessageId !== inboxMessageId) {
    throw new InvalidRecoveryError('recovery inbox identity is invalid');
  }
  if (indexOf(write.result.event) >= indexOf(lifecycle.acknowledged)) {
    throw new InvalidRecoveryError('durable completion ordering is invalid');
  }

  const durableFinalMarkerCount = countOccurrences(
    assistantText(events),
    input.finalMarker
  );
  const acpFinalMarkerCount = countOccurrences(client.agentText(), input.finalMarker);
  if (
    finalAssistantText(events) !== input.finalMarker ||
    durableFinalMarkerCount !== 1 ||
    acpFinalMarkerCount !== 1 ||
    client.overflowed()
  ) {
    throw new InvalidRecoveryError('final marker evidence is invalid');
  }
  const target = await readFile(input.targetPath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (target === undefined) return undefined;
  scanner.observe('target', target);
  if (scanner.seen) throw new SurfaceSecretError('surface secret');
  if (target !== input.expectedContent) {
    throw new InvalidRecoveryError('target content is invalid');
  }
  if (!(await inboxIsMissing(input.workspace, input.sessionId))) return undefined;

  return {
    interactionRequested: 1,
    interactionResponded: 1,
    interactionRecovered: 1,
    recoveryToolResults: 1,
    writeCalls: 1,
    writeResults: 1,
    inboxMissing: true,
    acpFinalMarkerCount: 1,
    durableFinalMarkerCount: 1,
    targetSha256: createHash('sha256').update(target).digest('hex'),
    targetBytes: Buffer.byteLength(target, 'utf8'),
  };
}

function childExitPromise(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunnerTimeoutError('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCompletion(
  input: DurableInteractionRecoveryAcpRunnerInput,
  client: DurableInteractionAcpClient,
  scanner: SecretScanner,
  child: ChildProcess,
  deadlineAt: number
): Promise<CompletionFacts> {
  return pollDurableInteractionCompletion({
    deadlineAt,
    inspect: () => inspectCompletion(input, client, scanner),
    assertActive: () => {
      if (scanner.seen) throw new SurfaceSecretError('surface secret');
      if (client.terminalFailure) {
        throw new InvalidRecoveryError('terminal recovery failure');
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new InvalidRecoveryError('ACP child exited before recovery');
      }
    },
  });
}

export async function pollDurableInteractionCompletion<T>(
  options: PollDurableInteractionCompletionOptions<T>
): Promise<T> {
  const intervalMs = options.intervalMs ?? 50;
  while (Date.now() < options.deadlineAt) {
    options.assertActive?.();
    const completion = await options.inspect();
    if (completion !== undefined) return completion;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new RunnerTimeoutError('timeout');
}

export async function withDurableInteractionStorageRoot<T>(
  storageRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = process.env.BLADE_STORAGE_ROOT;
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previous;
  }
}

function childEnvironment(
  input: DurableInteractionRecoveryAcpRunnerInput
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  };
  delete env[INPUT_ENV];
  return env;
}

function failureCode(
  error: unknown,
  stage: RunnerStage
): DurableInteractionRecoveryAcpFailureEvidence['code'] {
  if (error instanceof RunnerTimeoutError) return 'timeout';
  if (error instanceof SurfaceSecretError) return 'surface_secret';
  if (error instanceof InvalidRecoveryError) return 'invalid_recovery';
  if (stage === 'spawn') return 'spawn_failed';
  if (stage === 'close_session' || stage === 'eof' || stage === 'child_exit') {
    return 'cleanup_failed';
  }
  return 'protocol_failed';
}

function boundedFailureEvidence(
  code: DurableInteractionRecoveryAcpFailureEvidence['code'],
  secretSeen: boolean
): DurableInteractionRecoveryAcpFailureEvidence {
  return {
    success: false,
    stage: 'evidence',
    code,
    timedOut: false,
    secretSeen,
    termFallbackUsed: false,
    killFallbackUsed: false,
  };
}

export function serializeDurableInteractionRecoveryAcpEvidence(
  evidence: RunnerEvidence,
  secret: string,
  observedChunks: readonly string[] = []
): string {
  const scanner = new SecretScanner(secret);
  for (const chunk of observedChunks) scanner.observe('evidence', chunk);

  let serialized: string;
  try {
    serialized = JSON.stringify(evidence);
    scanner.observe('evidence', serialized);
  } catch {
    serialized = JSON.stringify(boundedFailureEvidence('invalid_recovery', false));
  }

  if (scanner.seen) {
    serialized = JSON.stringify(boundedFailureEvidence('surface_secret', true));
  } else if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    serialized = JSON.stringify(boundedFailureEvidence('invalid_recovery', false));
  }
  return serialized;
}

export async function runDurableInteractionRecoveryAcpRunner(
  input: DurableInteractionRecoveryAcpRunnerInput
): Promise<RunnerEvidence> {
  return withDurableInteractionStorageRoot(input.storageRoot, () =>
    runDurableInteractionRecoveryAcpRunnerWithStorage(input)
  );
}

async function runDurableInteractionRecoveryAcpRunnerWithStorage(
  input: DurableInteractionRecoveryAcpRunnerInput
): Promise<RunnerEvidence> {
  let stage: RunnerStage = 'spawn';
  let sessionClosed = false;
  let termFallbackUsed = false;
  let killFallbackUsed = false;
  let connection: acp.ClientSideConnection | undefined;
  let child: ChildProcess | undefined;
  let exitPromise: Promise<ChildExit> | undefined;
  const scanner = new SecretScanner(input.secret);
  const client = new DurableInteractionAcpClient(input, scanner);

  try {
    const seeded =
      (await new PersistentStore(input.workspace).loadEvents(input.sessionId)) ?? [];
    scanDurableEvents(seeded, (serializedEvent) =>
      scanner.observe('durable', serializedEvent)
    );
    questionDefinition(seeded, input);
    if (
      seeded.some(
        (event) =>
          event.type === 'interaction_responded' ||
          event.type === 'interaction_recovered' ||
          (event.type === 'part_created' && payloadRecord(event)?.toolName === 'Write')
      ) ||
      assistantText(seeded).includes(input.finalMarker) ||
      scanner.seen
    ) {
      throw scanner.seen
        ? new SurfaceSecretError('surface secret')
        : new InvalidRecoveryError('seed is not pending-only');
    }
    try {
      await access(input.targetPath);
      throw new InvalidRecoveryError('target exists before recovery');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }

    child = spawn(process.execPath, [input.cliEntry, '--acp'], {
      cwd: input.workspace,
      env: childEnvironment(input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    exitPromise = childExitPromise(child);
    if (!child.stdin || !child.stdout) {
      throw new InvalidRecoveryError('ACP stdio is unavailable');
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      scanner.observe('stderr', chunk.toString());
      if (scanner.seen && child?.exitCode === null && child.signalCode === null) {
        termFallbackUsed = true;
        child.kill('SIGTERM');
      }
    });
    connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        scannedAcpOutput(child.stdout, scanner)
      )
    );
    const deadlineAt = Date.now() + input.timeoutMs;

    stage = 'initialize';
    const initialized = await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
      Math.max(1, deadlineAt - Date.now())
    );
    if (!initialized.agentCapabilities?.sessionCapabilities?.close) {
      throw new InvalidRecoveryError('ACP session/close is unavailable');
    }
    if (scanner.seen) throw new SurfaceSecretError('surface secret');

    stage = 'load_session';
    const setup = await withTimeout(
      connection.loadSession({
        sessionId: input.sessionId,
        cwd: input.workspace,
        mcpServers: [],
      }),
      Math.max(1, deadlineAt - Date.now())
    );
    if (scanner.seen) throw new SurfaceSecretError('surface secret');

    stage = 'recovery';
    const completion = await waitForCompletion(
      input,
      client,
      scanner,
      child,
      deadlineAt
    );
    if (
      client.questionRequests.length !== 1 ||
      !client.requestMatched ||
      !client.optionMatched
    ) {
      throw new InvalidRecoveryError('question callback evidence is invalid');
    }

    stage = 'close_session';
    await withTimeout(
      connection.closeSession({ sessionId: input.sessionId }),
      NORMAL_CLOSE_TIMEOUT_MS
    );
    sessionClosed = true;

    stage = 'eof';
    await endChildInput(child);

    stage = 'child_exit';
    const [exit] = await Promise.all([
      withTimeout(exitPromise, NORMAL_CLOSE_TIMEOUT_MS),
      withTimeout(connection.closed, NORMAL_CLOSE_TIMEOUT_MS),
    ]);
    if (exit.code !== 0 || exit.signal !== null || scanner.seen) {
      throw scanner.seen
        ? new SurfaceSecretError('surface secret')
        : new InvalidRecoveryError('ACP child did not exit normally');
    }

    stage = 'evidence';
    return {
      success: true,
      sessionId: input.sessionId,
      modeId: String(setup.modes?.currentModeId ?? ''),
      questionRequests: 1,
      requestMatched: true,
      optionMatched: true,
      ...completion,
      sessionClosed: true,
      eofClosed: true,
      childExitCode: 0,
      childExitSignal: null,
      termFallbackUsed: false,
      killFallbackUsed: false,
      secretSeen: false,
    };
  } catch (error) {
    if (connection && !sessionClosed) {
      await withTimeout(
        connection.closeSession({ sessionId: input.sessionId }),
        2_000
      ).then(
        () => {
          sessionClosed = true;
        },
        () => undefined
      );
    }
    if (child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      await endChildInput(child).catch(() => undefined);
    }
    if (child && exitPromise && child.exitCode === null && child.signalCode === null) {
      const natural = await withTimeout(exitPromise, 2_000).then(
        () => true,
        () => false
      );
      if (!natural && child.exitCode === null && child.signalCode === null) {
        termFallbackUsed = true;
        child.kill('SIGTERM');
        const terminated = await withTimeout(
          exitPromise,
          FALLBACK_TERM_TIMEOUT_MS
        ).then(
          () => true,
          () => false
        );
        if (!terminated && child.exitCode === null && child.signalCode === null) {
          killFallbackUsed = true;
          child.kill('SIGKILL');
          await withTimeout(exitPromise, FALLBACK_KILL_TIMEOUT_MS).catch(
            () => undefined
          );
        }
      }
    }
    return {
      success: false,
      stage,
      code: scanner.seen ? 'surface_secret' : failureCode(error, stage),
      timedOut: error instanceof RunnerTimeoutError,
      secretSeen: scanner.seen,
      termFallbackUsed,
      killFallbackUsed,
    };
  }
}

function endChildInput(child: ChildProcess): Promise<void> {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    return Promise.resolve();
  }
  const stdin = child.stdin;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      stdin.off('error', onError);
      reject(error);
    };
    stdin.once('error', onError);
    stdin.end(() => {
      stdin.off('error', onError);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  let evidence: RunnerEvidence;
  let secret = '';
  try {
    const encoded = process.env[INPUT_ENV];
    if (!encoded) throw new Error('missing input');
    const input = parseDurableInteractionRecoveryAcpRunnerInput(encoded);
    secret = input.secret;
    delete process.env[INPUT_ENV];
    evidence = await runDurableInteractionRecoveryAcpRunner(input);
  } catch {
    evidence = {
      success: false,
      stage: 'input',
      code: 'invalid_input',
      timedOut: false,
      secretSeen: false,
      termFallbackUsed: false,
      killFallbackUsed: false,
    };
  }
  const output = serializeDurableInteractionRecoveryAcpEvidence(evidence, secret);
  const outputSucceeded =
    (JSON.parse(output) as { success?: unknown }).success === true;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
  });
  process.exit(outputSucceeded ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
