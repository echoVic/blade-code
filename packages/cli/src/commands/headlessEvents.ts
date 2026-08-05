/**
 * Stable JSONL event contract for headless CLI consumers.
 *
 * The external wire format intentionally uses snake_case so tests and sandbox
 * integrations can consume it without depending on internal TypeScript naming.
 */
import {
  Runtime,
  type Static,
  StringEnum,
  type TSchema,
  Type,
} from '../schema/index.js';
import { TaskListItemSchema } from '../tools/builtin/task/taskListTypes.js';

export const HEADLESS_EVENT_VERSION = 1 as const;

function event<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object({
    event_version: Type.Literal(HEADLESS_EVENT_VERSION),
    ...properties,
  });
}

const ContentDeltaEventSchema = event({
  type: Type.Literal('content_delta'),
  delta: Type.String(),
});

const ThinkingDeltaEventSchema = event({
  type: Type.Literal('thinking_delta'),
  delta: Type.String(),
});

const ThinkingEventSchema = event({
  type: Type.Literal('thinking'),
  content: Type.String(),
});

const StreamEndEventSchema = event({
  type: Type.Literal('stream_end'),
});

const ContentEventSchema = event({
  type: Type.Literal('content'),
  content: Type.String(),
});

const ToolKindSchema = StringEnum(['readonly', 'write', 'execute']);

const ToolStartEventSchema = event({
  type: Type.Literal('tool_start'),
  tool_name: Type.String(),
  summary: Type.String(),
  target: Type.Optional(Type.String()),
  tool_kind: Type.Optional(ToolKindSchema),
});

const ToolResultEventSchema = event({
  type: Type.Literal('tool_result'),
  tool_name: Type.String(),
  summary: Type.String(),
  target: Type.Optional(Type.String()),
  tool_kind: Type.Optional(ToolKindSchema),
  success: Type.Optional(Type.Boolean()),
  error_type: Type.Optional(Type.String()),
  error_message: Type.Optional(Type.String()),
});

const PhaseEventSchema = event({
  type: Type.Literal('phase'),
  phase: StringEnum([
    'turn',
    'searching',
    'inspecting',
    'target_hit',
    'executing',
    'completed',
  ]),
  status: StringEnum(['ongoing', 'hit', 'done']),
  message: Type.String(),
  turn: Type.Optional(Type.Number()),
  tool_name: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
});

const ToolDetailEventSchema = event({
  type: Type.Literal('tool_detail'),
  tool_name: Type.String(),
  detail: Type.String(),
});

const TaskUpdateEventSchema = event({
  type: Type.Literal('task_update'),
  tasks: Type.Array(TaskListItemSchema),
});

const SubagentEventSchema = event({
  type: Type.Literal('subagent'),
  state: StringEnum(['spawned', 'completed']),
  session_id: Type.String(),
  subagent_type: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  summary: Type.Optional(Type.String()),
  resumed_from: Type.Optional(Type.String()),
  root_agent_id: Type.Optional(Type.String()),
  resume_depth: Type.Optional(Type.Integer({ minimum: 0 })),
});

const TokenUsageEventSchema = event({
  type: Type.Literal('token_usage'),
  input_tokens: Type.Number(),
  output_tokens: Type.Number(),
  total_tokens: Type.Number(),
  max_context_tokens: Type.Number(),
  cache_read_tokens: Type.Optional(Type.Number()),
  cache_write_tokens: Type.Optional(Type.Number()),
  cost_usd: Type.Optional(Type.Number()),
});

const CompactingEventSchema = event({
  type: Type.Literal('compacting'),
  state: StringEnum(['started', 'completed']),
});

const TurnLimitEventSchema = event({
  type: Type.Literal('turn_limit'),
  turns_count: Type.Number(),
  action: Type.Literal('continue'),
});

const TaskSessionEventSchema = event({
  type: Type.Literal('task_session'),
  session_id: Type.String(),
  project_path: Type.String(),
  source_project_path: Type.String(),
  isolation: StringEnum(['local', 'worktree']),
  worktree_branch: Type.Optional(Type.String()),
  base_commit: Type.Optional(Type.String()),
});

const OutputEventSchema = event({
  type: Type.Literal('output'),
  content: Type.String(),
  exit_code: Type.Number(),
});

const ErrorEventSchema = event({
  type: Type.Literal('error'),
  message: Type.String(),
});

export const HeadlessJsonlEventSchema = Runtime(
  Type.Union([
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
    TaskSessionEventSchema,
    OutputEventSchema,
    ErrorEventSchema,
  ])
);

export type HeadlessJsonlEvent = Static<typeof HeadlessJsonlEventSchema>;
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
