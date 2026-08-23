import type { Message } from '../services/ChatServiceInterface.js';
import type { JsonValue } from '../store/types.js';

export const COMPACTION_CHECKPOINT_VERSION = 1;
export const MAX_COMPACTION_CHECKPOINT_MESSAGES = 4_096;
export const MAX_COMPACTION_CHECKPOINT_BYTES = 16 * 1024 * 1024;

export type CompactionReason = 'threshold' | 'context_limit' | 'turn_limit' | 'manual';

export type CompactionStrategy = 'llm' | 'fallback' | 'snip';

export type CompactionOutcome = 'completed' | 'fallback' | 'failed';

export type CompactionFailureReason =
  | 'circuit_open'
  | 'deterministic'
  | 'empty_exhausted'
  | 'transient_exhausted';

export interface CompactionPersistenceMetadata {
  trigger: 'auto' | 'manual';
  reason?: CompactionReason;
  strategy?: CompactionStrategy;
  preTokens: number;
  postTokens?: number;
  sampleAttempts?: number;
  failureReason?: CompactionFailureReason;
  filesIncluded?: string[];
  replacementMessages?: Message[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  return (
    value.type === 'image_url' &&
    isRecord(value.image_url) &&
    typeof value.image_url.url === 'string'
  );
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  if (!['system', 'user', 'assistant', 'tool'].includes(String(value.role))) {
    return false;
  }
  return (
    typeof value.content === 'string' ||
    (Array.isArray(value.content) && value.content.every(isContentPart))
  );
}

function parseSerializedMessages(value: unknown): Message[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_COMPACTION_CHECKPOINT_MESSAGES
  ) {
    return undefined;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_COMPACTION_CHECKPOINT_BYTES) {
    return undefined;
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!Array.isArray(cloned) || !cloned.every(isMessage)) return undefined;
  return cloned;
}

export function serializeCompactionReplacementMessages(
  messages: Message[]
): JsonValue[] {
  const serialized = parseSerializedMessages(messages);
  if (!serialized) {
    throw new Error('Compaction replacement context is invalid or exceeds limits');
  }
  return serialized as unknown as JsonValue[];
}

export function parseCompactionReplacementMessages(
  value: unknown
): Message[] | undefined {
  return parseSerializedMessages(value);
}
