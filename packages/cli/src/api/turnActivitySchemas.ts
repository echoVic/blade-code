import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

export const TURN_ACTIVITY_TOOL_NAME_MAX_CHARS = 128;
export const TURN_ACTIVITY_GENERATION_MAX_CHARS = 128;
export const TURN_ACTIVITY_ACTIVE_TOOL_LIMIT = 8;
const MAX_ACTIVITY_COUNTER = 1_000_000;
const MAX_UNIX_TIMESTAMP_MS = 8_640_000_000_000_000;

const BoundedCounterSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_ACTIVITY_COUNTER,
});
const TimestampSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_UNIX_TIMESTAMP_MS,
});
const ToolNameSchema = Type.String({
  minLength: 1,
  maxLength: TURN_ACTIVITY_TOOL_NAME_MAX_CHARS,
  pattern: '^[^\u0000-\u001f\u007f]+$',
});

export const TurnActivityPhaseSchema = StringEnum([
  'starting',
  'thinking',
  'responding',
  'executing_tools',
  'compacting',
  'continuing',
]);
export type TurnActivityPhase = Static<typeof TurnActivityPhaseSchema>;

export const TurnActivityToolSchema = Type.Refine(
  Type.Object(
    {
      name: ToolNameSchema,
      kind: Type.Optional(StringEnum(['readonly', 'write', 'execute'])),
      startedAt: TimestampSchema,
      progress: Type.Optional(BoundedCounterSchema),
      total: Type.Optional(BoundedCounterSchema),
    },
    { additionalProperties: false }
  ),
  (tool) =>
    (tool.progress === undefined && tool.total === undefined) ||
    (tool.progress !== undefined &&
      tool.total !== undefined &&
      tool.progress <= tool.total),
  () => 'progress and total must be present together with progress <= total'
);
export type TurnActivityTool = Static<typeof TurnActivityToolSchema>;

export const TurnActivitySnapshotSchema = Type.Refine(
  Type.Object(
    {
      phase: TurnActivityPhaseSchema,
      startedAt: TimestampSchema,
      updatedAt: TimestampSchema,
      turn: BoundedCounterSchema,
      maxTurns: Type.Union([BoundedCounterSchema, Type.Null()]),
      outputStarted: Type.Boolean(),
      toolCallsStarted: BoundedCounterSchema,
      toolCallsCompleted: BoundedCounterSchema,
      activeTools: Type.Array(TurnActivityToolSchema, {
        maxItems: TURN_ACTIVITY_ACTIVE_TOOL_LIMIT,
      }),
      activeToolOverflow: BoundedCounterSchema,
    },
    { additionalProperties: false }
  ),
  (snapshot) =>
    snapshot.startedAt <= snapshot.updatedAt &&
    snapshot.toolCallsCompleted <= snapshot.toolCallsStarted &&
    snapshot.activeTools.length + snapshot.activeToolOverflow <=
      snapshot.toolCallsStarted - snapshot.toolCallsCompleted,
  () => 'turn activity snapshot counters and timestamps are inconsistent'
);
export type TurnActivitySnapshot = Static<typeof TurnActivitySnapshotSchema>;

export const TurnActivityProjectionSchema = Runtime(
  Type.Object(
    {
      version: Type.Literal(1),
      generation: Type.String({
        minLength: 1,
        maxLength: TURN_ACTIVITY_GENERATION_MAX_CHARS,
        pattern: '^[^\u0000-\u001f\u007f]+$',
      }),
      revision: BoundedCounterSchema,
      snapshot: Type.Union([TurnActivitySnapshotSchema, Type.Null()]),
    },
    { additionalProperties: false }
  )
);
export type TurnActivityProjection = Static<typeof TurnActivityProjectionSchema>;

export function normalizeTurnActivityToolName(value: string): string {
  const normalized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim()
    .slice(0, TURN_ACTIVITY_TOOL_NAME_MAX_CHARS);
  if (!normalized) throw new Error('Turn activity tool name is empty');
  return normalized;
}
