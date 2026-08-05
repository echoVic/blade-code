/**
 * Stable JSONL event contract for headless CLI consumers.
 *
 * The external wire format intentionally uses snake_case so tests and sandbox
 * integrations can consume it without depending on internal TypeScript naming.
 */
import { z } from 'zod';
import { TaskListItemSchema } from '../tools/builtin/task/taskListTypes.js';

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
  target: z.string().optional(),
  tool_kind: z.enum(['readonly', 'write', 'execute']).optional(),
});

const ToolResultEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('tool_result'),
  tool_name: z.string(),
  summary: z.string(),
  target: z.string().optional(),
  tool_kind: z.enum(['readonly', 'write', 'execute']).optional(),
  success: z.boolean().optional(),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
});

const PhaseEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('phase'),
  phase: z.enum([
    'turn',
    'searching',
    'inspecting',
    'target_hit',
    'executing',
    'completed',
  ]),
  status: z.enum(['ongoing', 'hit', 'done']),
  message: z.string(),
  turn: z.number().optional(),
  tool_name: z.string().optional(),
  target: z.string().optional(),
});

const ToolDetailEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('tool_detail'),
  tool_name: z.string(),
  detail: z.string(),
});

const TaskUpdateEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('task_update'),
  tasks: z.array(TaskListItemSchema),
});

const SubagentEventSchema = HeadlessEventBaseSchema.extend({
  type: z.literal('subagent'),
  state: z.enum(['spawned', 'completed']),
  session_id: z.string(),
  subagent_type: z.string().optional(),
  success: z.boolean().optional(),
  summary: z.string().optional(),
  resumed_from: z.string().optional(),
  root_agent_id: z.string().optional(),
  resume_depth: z.number().int().nonnegative().optional(),
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
  PhaseEventSchema,
  ToolDetailEventSchema,
  TaskUpdateEventSchema,
  SubagentEventSchema,
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
