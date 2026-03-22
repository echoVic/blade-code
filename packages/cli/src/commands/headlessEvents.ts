/**
 * Stable JSONL event contract for headless CLI consumers.
 *
 * The external wire format intentionally uses snake_case so tests and sandbox
 * integrations can consume it without depending on internal TypeScript naming.
 */
import { z } from 'zod';
import { TodoItemSchema } from '../tools/builtin/todo/types.js';

export const HEADLESS_EVENT_VERSION = 1 as const;

const HeadlessEventBaseSchema = z.object({
  event_version: z.literal(HEADLESS_EVENT_VERSION),
});

const ContentDeltaEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('content_delta'),
  delta: z.string(),
});

const ThinkingDeltaEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('thinking_delta'),
  delta: z.string(),
});

const ThinkingEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('thinking'),
  content: z.string(),
});

const StreamEndEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('stream_end'),
});

const ContentEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('content'),
  content: z.string(),
});

const ToolStartEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('tool_start'),
  tool_name: z.string(),
  summary: z.string(),
});

const ToolResultEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('tool_result'),
  tool_name: z.string(),
  summary: z.string(),
});

const ToolDetailEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('tool_detail'),
  tool_name: z.string(),
  detail: z.string(),
});

const TodoUpdateEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('todo_update'),
  todos: z.array(TodoItemSchema),
});

const TokenUsageEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('token_usage'),
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  max_context_tokens: z.number(),
});

const CompactingEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('compacting'),
  state: z.enum(['started', 'completed']),
});

const TurnLimitEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('turn_limit'),
  turns_count: z.number(),
  action: z.literal('continue'),
});

const OutputEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('output'),
  content: z.string(),
  exit_code: z.number(),
});

const ErrorEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('error'),
  message: z.string(),
});

export const HeadlessJsonlEventSchema = z.discriminatedUnion('type', [
  ContentDeltaEventSchema,
  ThinkingDeltaEventSchema,
  ThinkingEventSchema,
  StreamEndEventSchema,
  ContentEventSchema,
  ToolStartEventSchema,
  ToolResultEventSchema,
  ToolDetailEventSchema,
  TodoUpdateEventSchema,
  TokenUsageEventSchema,
  CompactingEventSchema,
  TurnLimitEventSchema,
  OutputEventSchema,
  ErrorEventSchema,
]);

export type HeadlessJsonlEvent = z.infer<typeof HeadlessJsonlEventSchema>;
export type HeadlessJsonlEventType = HeadlessJsonlEvent['type'];
export type HeadlessJsonlEventPayload<TType extends HeadlessJsonlEventType> = Omit<
  Extract<HeadlessJsonlEvent, { type: TType }>,
  'event_version' | 'type'
>;

export function createHeadlessJsonlEvent<TType extends HeadlessJsonlEventType>(
  type: TType,
  payload: HeadlessJsonlEventPayload<TType>
): Extract<HeadlessJsonlEvent, { type: TType }> {
  return {
    event_version: HEADLESS_EVENT_VERSION,
    type,
    ...payload,
  } as Extract<HeadlessJsonlEvent, { type: TType }>;
}
