import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_QUEUE_MAX_ITEMS,
  FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS,
  FollowUpQueueErrorResponseSchema,
  FollowUpQueueMutationRequestSchema,
  FollowUpQueueMutationResponseSchema,
  FollowUpQueueSnapshotSchema,
} from '../../../src/api/followUpQueueSchemas.js';

const snapshot = () => ({
  version: 'a'.repeat(64),
  pending: 1,
  mutable: 1,
  locked: 0,
  internal: 0,
  items: [
    {
      id: 'message-1',
      position: 0,
      queuedAt: '2026-09-05T00:00:00.000Z',
      kind: 'user' as const,
      state: 'pending' as const,
      delivery: 'current_turn' as const,
      mutable: true,
      preview: 'Use the newer requirement',
      previewTruncated: false,
      attachmentCount: 0,
    },
  ],
});

describe('follow-up queue schemas', () => {
  it('accepts a bounded queue snapshot', () => {
    expect(FollowUpQueueSnapshotSchema.parse(snapshot())).toEqual(snapshot());
  });

  it('accepts remove and move mutations', () => {
    expect(
      FollowUpQueueMutationRequestSchema.parse({
        expectedVersion: 'b'.repeat(64),
        operation: { type: 'remove', messageId: 'message-1' },
      })
    ).toMatchObject({ operation: { type: 'remove' } });
    expect(
      FollowUpQueueMutationRequestSchema.parse({
        expectedVersion: 'c'.repeat(64),
        operation: { type: 'move', messageId: 'message-1', toPosition: 2 },
      })
    ).toMatchObject({ operation: { type: 'move', toPosition: 2 } });
  });

  it('accepts a successful mutation response', () => {
    expect(FollowUpQueueMutationResponseSchema.parse({ snapshot: snapshot() })).toEqual(
      { snapshot: snapshot() }
    );
  });

  it.each([
    'revision_conflict',
    'already_claimed',
    'immutable_origin',
    'immutable_boundary',
    'not_found',
    'runtime_unavailable',
    'invalid_mutation',
    'storage_unavailable',
  ] as const)('accepts the stable %s error code', (code) => {
    expect(
      FollowUpQueueErrorResponseSchema.parse({
        error: { code, message: 'Queue mutation failed' },
        snapshot: snapshot(),
      })
    ).toMatchObject({ error: { code } });
  });

  it('rejects unknown properties and malformed versions', () => {
    expect(() =>
      FollowUpQueueSnapshotSchema.parse({ ...snapshot(), secret: 'not allowed' })
    ).toThrow();
    expect(() =>
      FollowUpQueueSnapshotSchema.parse({ ...snapshot(), version: 'old-version' })
    ).toThrow();
  });

  it('bounds item count, preview length, and position', () => {
    const item = snapshot().items[0]!;
    expect(() =>
      FollowUpQueueSnapshotSchema.parse({
        ...snapshot(),
        pending: FOLLOW_UP_QUEUE_MAX_ITEMS + 1,
        mutable: FOLLOW_UP_QUEUE_MAX_ITEMS + 1,
        items: Array.from({ length: FOLLOW_UP_QUEUE_MAX_ITEMS + 1 }, (_, index) => ({
          ...item,
          id: 'message-' + index,
          position: index,
        })),
      })
    ).toThrow();
    expect(() =>
      FollowUpQueueSnapshotSchema.parse({
        ...snapshot(),
        items: [
          {
            ...item,
            preview: 'x'.repeat(FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS + 1),
          },
        ],
      })
    ).toThrow();
    expect(() =>
      FollowUpQueueMutationRequestSchema.parse({
        expectedVersion: 'd'.repeat(64),
        operation: { type: 'move', messageId: 'message-1', toPosition: -1 },
      })
    ).toThrow();
  });

  it('rejects unknown mutation and error codes', () => {
    expect(() =>
      FollowUpQueueMutationRequestSchema.parse({
        expectedVersion: 'e'.repeat(64),
        operation: { type: 'edit', messageId: 'message-1', text: 'changed' },
      })
    ).toThrow();
    expect(() =>
      FollowUpQueueErrorResponseSchema.parse({
        error: { code: 'unknown', message: 'Queue mutation failed' },
        snapshot: snapshot(),
      })
    ).toThrow();
  });
});
