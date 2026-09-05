import { createHash } from 'node:crypto';
import {
  FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS,
  type FollowUpQueueErrorCode,
  type FollowUpQueueMutation,
  type FollowUpQueueMutationResult,
  type FollowUpQueueSnapshot,
} from '../../api/followUpQueueSchemas.js';
import type { DurableSteeringMessage } from './DurableSteeringInbox.js';

const VERSION_DOMAIN = 'blade-follow-up-queue-snapshot-v1\0';
const INTERNAL_ID_DOMAIN = 'blade-follow-up-queue-internal-id-v1\0';
const EMPTY_VERSION = createHash('sha256')
  .update(VERSION_DOMAIN)
  .update('canonical-empty')
  .digest('hex');

export interface FollowUpQueueProjectionInput {
  generation: string;
  ownerEpoch: string;
  claimRevision: number;
  messages: readonly DurableSteeringMessage[];
  primaryInputIds: ReadonlySet<string>;
  reservedIds: ReadonlySet<string>;
  claimedIds: ReadonlySet<string>;
  recoveryProtectedIds: ReadonlySet<string>;
  hasActiveTurn: boolean;
}

export class FollowUpQueueMutationError extends Error {
  constructor(
    readonly code: FollowUpQueueErrorCode,
    readonly snapshot: FollowUpQueueSnapshot,
    message: string = code
  ) {
    super(message);
    this.name = 'FollowUpQueueMutationError';
  }
}

export function emptyFollowUpQueueSnapshot(): FollowUpQueueSnapshot {
  return {
    version: EMPTY_VERSION,
    pending: 0,
    mutable: 0,
    locked: 0,
    internal: 0,
    items: [],
  };
}

function isInternal(message: DurableSteeringMessage): boolean {
  return (message.origin ?? 'user') !== 'user';
}

function isArtifactBacked(message: DurableSteeringMessage): boolean {
  const metadata = message.metadata;
  return (
    metadata !== undefined &&
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.hasOwn(metadata, 'userPromptArtifact')
  );
}

function contentText(content: DurableSteeringMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function attachmentCount(content: DurableSteeringMessage['content']): number {
  return typeof content === 'string'
    ? 0
    : content.filter((part) => part.type === 'image_url').length;
}

function boundedPreview(content: DurableSteeringMessage['content']): {
  preview: string;
  previewTruncated: boolean;
} {
  const value = contentText(content);
  if (value.length <= FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS) {
    return { preview: value, previewTruncated: false };
  }
  let end = FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { preview: value.slice(0, end), previewTruncated: true };
}

function internalId(id: string): string {
  return createHash('sha256').update(INTERNAL_ID_DOMAIN).update(id).digest('hex');
}

function version(input: FollowUpQueueProjectionInput): string {
  const protectedIds = input.messages.flatMap((message) =>
    input.reservedIds.has(message.id) ||
    input.claimedIds.has(message.id) ||
    input.recoveryProtectedIds.has(message.id)
      ? [message.id]
      : []
  );
  return createHash('sha256')
    .update(VERSION_DOMAIN)
    .update(
      JSON.stringify([
        input.generation,
        input.ownerEpoch,
        input.claimRevision,
        input.hasActiveTurn,
        input.messages.map((message) => message.id),
        [...input.primaryInputIds].sort(),
        protectedIds,
      ])
    )
    .digest('hex');
}

export function projectFollowUpQueue(
  input: FollowUpQueueProjectionInput
): FollowUpQueueSnapshot {
  let mutable = 0;
  let locked = 0;
  let internal = 0;
  const visibleMessages = input.messages.filter(
    (message) => !input.primaryInputIds.has(message.id)
  );
  const items = visibleMessages.map((message, position) => {
    const internalItem = isInternal(message);
    const artifactBacked = isArtifactBacked(message);
    const protectedItem =
      internalItem ||
      input.reservedIds.has(message.id) ||
      input.claimedIds.has(message.id) ||
      input.recoveryProtectedIds.has(message.id) ||
      message.persisted === true ||
      message.outputSchema !== undefined ||
      artifactBacked;
    if (internalItem) internal++;
    if (protectedItem) locked++;
    else mutable++;
    const preview =
      internalItem || artifactBacked ? undefined : boundedPreview(message.content);
    return {
      id: internalItem ? internalId(message.id) : message.id,
      position,
      queuedAt: new Date(message.queuedAt).toISOString(),
      kind: internalItem ? ('internal' as const) : ('user' as const),
      state: protectedItem ? ('locked' as const) : ('pending' as const),
      delivery: message.recovered
        ? ('recovery' as const)
        : input.hasActiveTurn
          ? ('current_turn' as const)
          : ('next_turn' as const),
      mutable: !protectedItem,
      ...(preview ? { preview: preview.preview } : {}),
      previewTruncated: preview?.previewTruncated ?? false,
      attachmentCount: internalItem ? 0 : attachmentCount(message.content),
    };
  });
  return {
    version: version(input),
    pending: items.length,
    mutable,
    locked,
    internal,
    items,
  };
}

export function applyFollowUpQueueMutation(
  messages: readonly DurableSteeringMessage[],
  operation: FollowUpQueueMutation,
  snapshot: FollowUpQueueSnapshot
): DurableSteeringMessage[] {
  const itemIndex = snapshot.items.findIndex((item) => item.id === operation.messageId);
  if (itemIndex < 0) {
    throw new FollowUpQueueMutationError('not_found', snapshot);
  }
  const item = snapshot.items[itemIndex]!;
  if (!item.mutable) {
    throw new FollowUpQueueMutationError(
      item.kind === 'internal' ? 'immutable_origin' : 'already_claimed',
      snapshot
    );
  }
  const sourceIndex = messages.findIndex((message) => message.id === item.id);
  if (sourceIndex < 0) {
    throw new FollowUpQueueMutationError('not_found', snapshot);
  }
  if (operation.type === 'remove') {
    return messages.filter((_, index) => index !== sourceIndex);
  }
  const targetItem = snapshot.items[operation.toPosition];
  if (!targetItem) {
    throw new FollowUpQueueMutationError('invalid_mutation', snapshot);
  }
  const start = Math.min(itemIndex, operation.toPosition);
  const end = Math.max(itemIndex, operation.toPosition);
  if (snapshot.items.slice(start, end + 1).some((candidate) => !candidate.mutable)) {
    throw new FollowUpQueueMutationError('immutable_boundary', snapshot);
  }
  if (operation.toPosition === itemIndex) return [...messages];
  const targetIndex = messages.findIndex((message) => message.id === targetItem.id);
  if (targetIndex < 0) {
    throw new FollowUpQueueMutationError('not_found', snapshot);
  }
  const next = [...messages];
  const [selected] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, selected!);
  return next;
}
