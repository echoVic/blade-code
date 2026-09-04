import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

export const FOLLOW_UP_QUEUE_MAX_ITEMS = 160;
export const FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS = 240;

export const FollowUpQueueVersionSchema = Type.String({
  pattern: '^[a-f0-9]{64}$',
});

export const FollowUpQueueItemSchema = Runtime(
  Type.Object(
    {
      id: Type.String({ minLength: 1, maxLength: 128 }),
      position: Type.Integer({
        minimum: 0,
        maximum: FOLLOW_UP_QUEUE_MAX_ITEMS - 1,
      }),
      queuedAt: Type.String({ minLength: 20, maxLength: 32 }),
      kind: StringEnum(['user', 'internal']),
      state: StringEnum(['pending', 'locked']),
      delivery: StringEnum(['current_turn', 'next_turn', 'recovery']),
      mutable: Type.Boolean(),
      preview: Type.Optional(
        Type.String({ maxLength: FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS })
      ),
      previewTruncated: Type.Boolean(),
      attachmentCount: Type.Integer({ minimum: 0, maximum: 20 }),
    },
    { additionalProperties: false }
  )
);
export type FollowUpQueueItem = Static<typeof FollowUpQueueItemSchema>;

export const FollowUpQueueSnapshotSchema = Runtime(
  Type.Object(
    {
      version: FollowUpQueueVersionSchema,
      pending: Type.Integer({ minimum: 0, maximum: FOLLOW_UP_QUEUE_MAX_ITEMS }),
      mutable: Type.Integer({ minimum: 0, maximum: FOLLOW_UP_QUEUE_MAX_ITEMS }),
      locked: Type.Integer({ minimum: 0, maximum: FOLLOW_UP_QUEUE_MAX_ITEMS }),
      internal: Type.Integer({ minimum: 0, maximum: FOLLOW_UP_QUEUE_MAX_ITEMS }),
      items: Type.Array(FollowUpQueueItemSchema, {
        maxItems: FOLLOW_UP_QUEUE_MAX_ITEMS,
      }),
    },
    { additionalProperties: false }
  )
);
export type FollowUpQueueSnapshot = Static<typeof FollowUpQueueSnapshotSchema>;

export const FollowUpQueueMutationSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('remove'),
      messageId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('move'),
      messageId: Type.String({ minLength: 1, maxLength: 128 }),
      toPosition: Type.Integer({
        minimum: 0,
        maximum: FOLLOW_UP_QUEUE_MAX_ITEMS - 1,
      }),
    },
    { additionalProperties: false }
  ),
]);
export type FollowUpQueueMutation = Static<typeof FollowUpQueueMutationSchema>;

export const FollowUpQueueMutationRequestSchema = Runtime(
  Type.Object(
    {
      expectedVersion: FollowUpQueueVersionSchema,
      operation: FollowUpQueueMutationSchema,
    },
    { additionalProperties: false }
  )
);
export type FollowUpQueueMutationRequest = Static<
  typeof FollowUpQueueMutationRequestSchema
>;

export const FollowUpQueueMutationResponseSchema = Runtime(
  Type.Object(
    { snapshot: FollowUpQueueSnapshotSchema },
    { additionalProperties: false }
  )
);
export type FollowUpQueueMutationResponse = Static<
  typeof FollowUpQueueMutationResponseSchema
>;

export const FollowUpQueueErrorCodeSchema = StringEnum([
  'revision_conflict',
  'already_claimed',
  'immutable_origin',
  'immutable_boundary',
  'not_found',
  'runtime_unavailable',
  'invalid_mutation',
  'storage_unavailable',
]);
export type FollowUpQueueErrorCode = Static<typeof FollowUpQueueErrorCodeSchema>;

export const FollowUpQueueErrorResponseSchema = Runtime(
  Type.Object(
    {
      error: Type.Object(
        {
          code: FollowUpQueueErrorCodeSchema,
          message: Type.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false }
      ),
      snapshot: FollowUpQueueSnapshotSchema,
    },
    { additionalProperties: false }
  )
);
export type FollowUpQueueErrorResponse = Static<
  typeof FollowUpQueueErrorResponseSchema
>;
