import type { SessionEvent } from '../context/types.js';

const REWIND_PREVIEW_CHARS = 160;

export interface SessionRewindCheckpoint {
  messageId: string;
  preview: string;
  createdAt: string;
}

export interface SessionRewindPlan {
  checkpoint: SessionRewindCheckpoint;
  projectedEntries: SessionEvent[];
  removedTurns: number;
  snapshotMessageIds: string[];
}

function isConversationEvent(event: SessionEvent): boolean {
  return (
    event.type === 'message_created' ||
    event.type === 'part_created' ||
    event.type === 'part_updated' ||
    event.type === 'interaction_requested' ||
    event.type === 'interaction_responded' ||
    event.type === 'interaction_recovered'
  );
}

function isUserCheckpoint(
  event: SessionEvent
): event is Extract<SessionEvent, { type: 'message_created' }> {
  return (
    event.type === 'message_created' &&
    event.data.role === 'user' &&
    (event.data.inboxMessageId !== undefined ||
      event.data.parentMessageId === undefined)
  );
}

function getCheckpoint(
  entries: readonly SessionEvent[],
  messageId: string
): SessionRewindCheckpoint {
  const message = entries.find(
    (event): event is Extract<SessionEvent, { type: 'message_created' }> =>
      isUserCheckpoint(event) && event.data.messageId === messageId
  );
  if (!message) {
    throw new Error(`Rewind checkpoint not found: ${messageId}`);
  }

  return {
    messageId,
    preview: getMessagePreview(entries, messageId),
    createdAt: message.data.createdAt,
  };
}

function getMessagePreview(
  entries: readonly SessionEvent[],
  messageId: string
): string {
  const text = entries
    .flatMap((event) => {
      if (event.type !== 'part_created' || event.data.messageId !== messageId) {
        return [];
      }
      if (event.data.partType === 'text') {
        const payload = event.data.payload as { text?: unknown };
        return typeof payload.text === 'string' ? [payload.text] : [];
      }
      if (event.data.partType === 'image') return ['[Image]'];
      return [];
    })
    .join('')
    .trim();

  if (text.length <= REWIND_PREVIEW_CHARS) return text;
  return `${text.slice(0, REWIND_PREVIEW_CHARS)}...`;
}

function projectBeforeCheckpoint(
  entries: readonly SessionEvent[],
  targetMessageId: string
): SessionEvent[] {
  getCheckpoint(entries, targetMessageId);
  const targetIndex = entries.findIndex(
    (event) =>
      event.type === 'message_created' && event.data.messageId === targetMessageId
  );

  return entries.filter(
    (event, index) => index < targetIndex || !isConversationEvent(event)
  );
}

export function materializeSessionEvents(
  entries: readonly SessionEvent[]
): SessionEvent[] {
  let projected: SessionEvent[] = [];

  for (const event of entries) {
    if (event.type !== 'session_rewound') {
      projected.push(event);
      continue;
    }

    getCheckpoint(projected, event.data.targetMessageId);
    if (event.data.mode !== 'code') {
      projected = projectBeforeCheckpoint(projected, event.data.targetMessageId);
    }
  }

  return projected;
}

export function listSessionRewindCheckpoints(
  entries: readonly SessionEvent[]
): SessionRewindCheckpoint[] {
  const projected = materializeSessionEvents(entries);
  return projected
    .filter(isUserCheckpoint)
    .map((event) => ({
      messageId: event.data.messageId,
      preview: getMessagePreview(projected, event.data.messageId),
      createdAt: event.data.createdAt,
    }))
    .reverse();
}

export function planSessionRewind(
  entries: readonly SessionEvent[],
  targetMessageId: string
): SessionRewindPlan {
  const projected = materializeSessionEvents(entries);
  const checkpoint = getCheckpoint(projected, targetMessageId);
  const targetIndex = projected.findIndex(
    (event) =>
      event.type === 'message_created' && event.data.messageId === targetMessageId
  );
  const removed = projected.slice(targetIndex);

  return {
    checkpoint,
    projectedEntries: projectBeforeCheckpoint(projected, targetMessageId),
    removedTurns: removed.filter(isUserCheckpoint).length,
    snapshotMessageIds: removed.flatMap((event) =>
      event.type === 'part_created' && event.data.partType === 'tool_call'
        ? [event.data.partId]
        : []
    ),
  };
}
