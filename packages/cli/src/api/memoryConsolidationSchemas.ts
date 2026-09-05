import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

export const MemoryConsolidationTopicSchema = StringEnum([
  'preferences',
  'conventions',
  'lessons',
  'debugging',
]);
export type MemoryConsolidationTopic = Static<typeof MemoryConsolidationTopicSchema>;

const EmptyMemoryConsolidationProjectionSchema = Type.Object(
  {
    outcome: StringEnum(['nothing_to_store', 'disabled', 'failed']),
    entries: Type.Literal(0),
    topics: Type.Tuple([]),
  },
  { additionalProperties: false }
);

const WrittenMemoryConsolidationProjectionSchema = Type.Object(
  {
    outcome: Type.Literal('written'),
    entries: Type.Integer({ minimum: 1, maximum: 20 }),
    topics: Type.Array(MemoryConsolidationTopicSchema, {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const MemoryConsolidationProjectionSchema = Runtime(
  Type.Union([
    WrittenMemoryConsolidationProjectionSchema,
    EmptyMemoryConsolidationProjectionSchema,
  ])
);
export type MemoryConsolidationProjection = Static<
  typeof MemoryConsolidationProjectionSchema
>;
