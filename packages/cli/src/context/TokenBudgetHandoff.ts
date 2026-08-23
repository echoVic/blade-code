import type { Message } from '../services/ChatServiceInterface.js';
import type { ContextTokenSource } from './ContextTokenTracker.js';
import { parseCompactionReplacementMessages } from './compactionCheckpoint.js';
import type {
  MessagePersistenceMetadata,
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from './types.js';

export const TOKEN_BUDGET_HANDOFF_VERSION = 1 as const;
export const TOKEN_BUDGET_HANDOFF_RATIO = 0.7;
export const TOKEN_BUDGET_COMPACTION_RATIO = 0.8;
export const TOKEN_BUDGET_HANDOFF_MAX_BYTES = 2000;
export const TOKEN_BUDGET_HANDOFF_TAG = '<token-budget-handoff version="1">';
export const TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX = 'handoff-message-';

const MAX_MESSAGE_ID_LENGTH = 128;
const TOKEN_BUDGET_HANDOFF_DATA_KEYS = [
  'version',
  'messageId',
  'observedPromptTokens',
  'availableForInput',
  'handoffThreshold',
  'compactionThreshold',
  'createdAt',
] as const;
const CANONICAL_UTC_MILLISECOND_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEADROOM_TAIL =
  /(?:^|\n)Remaining prompt-token headroom before compaction: (\d+)\.$/;

export type TokenBudgetPhase =
  | 'unknown'
  | 'below_handoff'
  | 'handoff_band'
  | 'compaction_due';

export interface TokenBudgetSnapshot {
  phase: TokenBudgetPhase;
  contextTokens?: number;
  tokenSource?: ContextTokenSource;
  estimatedPendingTokens?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  availableForInput?: number;
  handoffThreshold?: number;
  compactionThreshold?: number;
}

export interface TokenBudgetHandoffRecordedV1 {
  version: 1;
  messageId: string;
  observedPromptTokens: number;
  availableForInput: number;
  handoffThreshold: number;
  compactionThreshold: number;
  createdAt: string;
}

export type ValidTokenBudgetHandoffEvent = TokenBudgetHandoffRecordedEvent & {
  data: TokenBudgetHandoffRecordedV1;
};

export type CurrentTokenBudgetHandoff =
  | { kind: 'none' }
  | { kind: 'valid'; event: ValidTokenBudgetHandoffEvent }
  | { kind: 'suppressed'; recordId: string };

interface DeriveSnapshotInput {
  contextTokens?: number;
  tokenSource?: TokenBudgetSnapshot['tokenSource'];
  estimatedPendingTokens?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

interface ResolveCompactionOutputReserveInput {
  maxContextTokens?: number;
  maxOutputTokens?: number | null;
  configuredMaxOutputTokens?: number | null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStrictPositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isValidMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_MESSAGE_ID_LENGTH &&
    !hasControlCharacters(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactThreshold(availableForInput: number, numerator: number): number {
  const quotient = Math.floor(availableForInput / 10);
  const remainder = availableForInput % 10;
  return quotient * numerator + Math.floor((remainder * numerator) / 10);
}

function isCanonicalUtcMillisecondIso(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC_MILLISECOND_ISO.test(value)) {
    return false;
  }

  try {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
}

function renderReminder(headroom: number): string {
  if (!isSafeNonNegativeInteger(headroom)) {
    throw new Error('Token budget handoff headroom must be a safe nonnegative integer');
  }

  return [
    TOKEN_BUDGET_HANDOFF_TAG,
    'Context rollover is approaching. Continue the user task from this state only.',
    'Make objective, decisions, mutations, verification, background work, blockers, and the exact next action explicit.',
    'For pending work, preserve exact commands, tool arguments, and required final-response constraints when they are known.',
    'Do not claim success or completion unless it is already proven in the transcript.',
    'Do not create bookkeeping files the user did not request.',
    `Remaining prompt-token headroom before compaction: ${headroom}.`,
  ].join('\n');
}

function boundedReminder(headroom: number): string {
  const reminder = renderReminder(headroom);
  const bytes = new TextEncoder().encode(reminder).length;
  if (bytes > TOKEN_BUDGET_HANDOFF_MAX_BYTES) {
    throw new Error(
      `Token budget handoff reminder exceeds ${TOKEN_BUDGET_HANDOFF_MAX_BYTES} bytes`
    );
  }
  return reminder;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

export function resolveCompactionOutputReserve(
  input: ResolveCompactionOutputReserveInput
): number | undefined {
  const { maxContextTokens, maxOutputTokens, configuredMaxOutputTokens } = input;
  const explicitOutputTokens =
    maxOutputTokens ?? configuredMaxOutputTokens ?? undefined;
  if (explicitOutputTokens !== undefined) {
    return explicitOutputTokens;
  }
  if (!isStrictPositiveInteger(maxContextTokens)) {
    return undefined;
  }
  return Math.min(Math.max(Math.floor(maxContextTokens * 0.1), 8192), 32768);
}

export function deriveTokenBudgetSnapshot(
  input: DeriveSnapshotInput
): TokenBudgetSnapshot {
  const {
    contextTokens,
    tokenSource,
    estimatedPendingTokens,
    maxContextTokens,
    maxOutputTokens,
  } = input;

  if (
    !isStrictPositiveInteger(maxContextTokens) ||
    !isSafeNonNegativeInteger(maxOutputTokens) ||
    maxOutputTokens >= maxContextTokens
  ) {
    return { phase: 'unknown' };
  }

  const availableForInput = maxContextTokens - maxOutputTokens;
  if (availableForInput <= 0) {
    return { phase: 'unknown' };
  }

  const handoffThreshold = exactThreshold(availableForInput, 7);
  const compactionThreshold = exactThreshold(availableForInput, 8);

  if (!isSafeNonNegativeInteger(contextTokens)) {
    return {
      phase: 'unknown',
      ...(tokenSource ? { tokenSource } : {}),
      ...(isSafeNonNegativeInteger(estimatedPendingTokens)
        ? { estimatedPendingTokens }
        : {}),
      maxContextTokens,
      maxOutputTokens,
      availableForInput,
      handoffThreshold,
      compactionThreshold,
    };
  }

  const projection = {
    contextTokens,
    ...(tokenSource ? { tokenSource } : {}),
    ...(isSafeNonNegativeInteger(estimatedPendingTokens)
      ? { estimatedPendingTokens }
      : {}),
    maxContextTokens,
    maxOutputTokens,
    availableForInput,
    handoffThreshold,
    compactionThreshold,
  };

  if (contextTokens < handoffThreshold) {
    return {
      phase: 'below_handoff',
      ...projection,
    };
  }

  if (contextTokens < compactionThreshold) {
    return {
      phase: 'handoff_band',
      ...projection,
    };
  }

  return {
    phase: 'compaction_due',
    ...projection,
  };
}

export function parseTokenBudgetHandoffEvent(
  event: SessionEvent
): ValidTokenBudgetHandoffEvent | undefined {
  if (event.type !== 'token_budget_handoff_recorded' || !isPlainObject(event.data)) {
    return undefined;
  }

  const data = event.data;
  if (
    !exactKeys(data, TOKEN_BUDGET_HANDOFF_DATA_KEYS) ||
    data.version !== TOKEN_BUDGET_HANDOFF_VERSION ||
    !isValidMessageId(data.messageId) ||
    !isSafeNonNegativeInteger(data.observedPromptTokens) ||
    !isStrictPositiveInteger(data.availableForInput) ||
    !isSafeNonNegativeInteger(data.handoffThreshold) ||
    !isSafeNonNegativeInteger(data.compactionThreshold) ||
    !isCanonicalUtcMillisecondIso(data.createdAt)
  ) {
    return undefined;
  }

  const expectedHandoffThreshold = exactThreshold(data.availableForInput, 7);
  const expectedCompactionThreshold = exactThreshold(data.availableForInput, 8);

  if (
    data.handoffThreshold !== expectedHandoffThreshold ||
    data.compactionThreshold !== expectedCompactionThreshold ||
    data.observedPromptTokens < data.handoffThreshold ||
    data.observedPromptTokens >= data.compactionThreshold
  ) {
    return undefined;
  }

  return event as ValidTokenBudgetHandoffEvent;
}

export function isTokenBudgetHandoffEvent(
  event: SessionEvent
): event is TokenBudgetHandoffRecordedEvent {
  return event.type === 'token_budget_handoff_recorded';
}

export function findCurrentTokenBudgetHandoff(
  materializedEvents: readonly SessionEvent[]
): CurrentTokenBudgetHandoff {
  const checkpointIndex = materializedEvents.findLastIndex((event) => {
    if (event.type !== 'part_created' || event.data.partType !== 'summary') {
      return false;
    }
    const payload = event.data.payload;
    return (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      parseCompactionReplacementMessages(payload.replacementMessages) !== undefined
    );
  });
  const records = materializedEvents
    .slice(checkpointIndex + 1)
    .filter(isTokenBudgetHandoffEvent);
  if (records.length === 0) return { kind: 'none' };

  const latest = records.at(-1);
  if (!latest) return { kind: 'none' };
  if (records.length !== 1) {
    return { kind: 'suppressed', recordId: latest.id };
  }

  const parsed = parseTokenBudgetHandoffEvent(latest);
  return parsed
    ? { kind: 'valid', event: parsed }
    : { kind: 'suppressed', recordId: latest.id };
}

export function projectTokenBudgetHandoffEvent(
  event: SessionEvent
): Message | undefined {
  const parsed = parseTokenBudgetHandoffEvent(event);
  if (!parsed) return undefined;

  const metadata = {
    clientVisible: false,
    tokenBudgetHandoff: {
      version: TOKEN_BUDGET_HANDOFF_VERSION,
      messageId: parsed.data.messageId,
    },
  } satisfies MessagePersistenceMetadata & {
    tokenBudgetHandoff: {
      version: 1;
      messageId: string;
    };
  };

  return {
    id: parsed.data.messageId,
    role: 'user',
    content: boundedReminder(
      Math.max(0, parsed.data.compactionThreshold - parsed.data.observedPromptTokens)
    ),
    metadata,
  };
}

export function isTokenBudgetHandoffMessage(message: Message): boolean {
  if (
    typeof message.id !== 'string' ||
    message.role !== 'user' ||
    typeof message.content !== 'string' ||
    !isPlainObject(message.metadata) ||
    message.metadata.clientVisible !== false
  ) {
    return false;
  }

  const metadata = message.metadata as Record<string, unknown>;
  if (!exactKeys(metadata, ['clientVisible', 'tokenBudgetHandoff'])) {
    return false;
  }

  const marker = metadata.tokenBudgetHandoff;
  if (!isPlainObject(marker)) return false;
  if (!exactKeys(marker, ['messageId', 'version'])) return false;
  if (
    marker.version !== TOKEN_BUDGET_HANDOFF_VERSION ||
    !isValidMessageId(marker.messageId) ||
    marker.messageId !== message.id
  ) {
    return false;
  }

  const bytes = new TextEncoder().encode(message.content).length;
  if (bytes > TOKEN_BUDGET_HANDOFF_MAX_BYTES) return false;

  const headroomMatch = HEADROOM_TAIL.exec(message.content);
  if (!headroomMatch) return false;

  const headroom = Number(headroomMatch[1]);
  return (
    isSafeNonNegativeInteger(headroom) && message.content === renderReminder(headroom)
  );
}

export function stripTokenBudgetHandoffMessages(
  messages: readonly Message[]
): Message[] {
  return messages.filter((message) => !isTokenBudgetHandoffMessage(message));
}
