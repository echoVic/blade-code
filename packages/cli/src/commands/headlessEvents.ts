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

const StructuredOutputEventSchema = event({
  type: Type.Literal('structured_output'),
  output: Type.Record(Type.String(), Type.Unknown()),
  schema_digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});

const ToolKindSchema = StringEnum(['readonly', 'write', 'execute']);

const ToolStartEventSchema = event({
  type: Type.Literal('tool_start'),
  tool_name: Type.String(),
  summary: Type.String(),
  target: Type.Optional(Type.String()),
  tool_kind: Type.Optional(ToolKindSchema),
});

const ToolProgressEventSchema = event({
  type: Type.Literal('tool_progress'),
  tool_name: Type.String(),
  message: Type.String(),
  progress: Type.Optional(Type.Number()),
  total: Type.Optional(Type.Number()),
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

const McpCatalogChangedEventSchema = event({
  type: Type.Literal('mcp_catalog_changed'),
  revision: Type.Integer({ minimum: 1 }),
  server_name: Type.String(),
  added: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  updated: Type.Array(Type.String()),
});

const McpContentChangedEventSchema = event({
  type: Type.Literal('mcp_content_changed'),
  revision: Type.Integer({ minimum: 1 }),
  server_name: Type.String(),
  content_kind: StringEnum(['resources', 'resource_templates', 'prompts']),
  added: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  updated: Type.Array(Type.String()),
});

const McpResourceUpdatedEventSchema = event({
  type: Type.Literal('mcp_resource_updated'),
  revision: Type.Integer({ minimum: 1 }),
  server_name: Type.String(),
  uri: Type.String(),
});

const McpConnectionChangedEventSchema = event({
  type: Type.Literal('mcp_connection_changed'),
  revision: Type.Integer({ minimum: 1 }),
  server_name: Type.String(),
  phase: StringEnum(['reconnecting', 'recovered', 'failed']),
  reason: Type.String(),
  attempt: Type.Integer({ minimum: 0 }),
  max_attempts: Type.Integer({ minimum: 0 }),
  next_retry_at: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

const McpLogEventSchema = event({
  type: Type.Literal('mcp_log'),
  revision: Type.Integer({ minimum: 1 }),
  server_name: Type.String(),
  level: StringEnum([
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
  ]),
  logger: Type.Optional(Type.String()),
  message: Type.String(),
  projected_bytes: Type.Integer({ minimum: 0 }),
  data_sha256: Type.String(),
  truncated: Type.Boolean(),
  details_omitted: Type.Boolean(),
  timestamp: Type.Integer({ minimum: 0 }),
  synthetic: Type.Optional(Type.Boolean()),
});

const McpInstructionsChangedEventSchema = event({
  type: Type.Literal('mcp_instructions_changed'),
  revision: Type.Integer({ minimum: 0 }),
  server_name: Type.String(),
  action: StringEnum(['added', 'removed']),
  reason: StringEnum(['snapshot', 'connection', 'disconnection']),
  text: Type.Optional(Type.String()),
  source_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  projected_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  sha256: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  details_omitted: Type.Optional(Type.Boolean()),
});

const McpTaskChangedEventSchema = event({
  type: Type.Literal('mcp_task_changed'),
  revision: Type.Integer({ minimum: 0 }),
  task_id: Type.String(),
  server_name: Type.String(),
  tool_name: Type.String(),
  status: StringEnum([
    'working',
    'input_required',
    'interrupted',
    'completed',
    'failed',
    'cancelled',
  ]),
  status_message: Type.Optional(Type.String()),
  created_at: Type.Integer({ minimum: 0 }),
  updated_at: Type.Integer({ minimum: 0 }),
  completed_at: Type.Optional(Type.Integer({ minimum: 0 })),
  has_result: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

const ProjectRulesLoadedEventSchema = event({
  type: Type.Literal('project_rules_loaded'),
  files: Type.Array(
    Type.Object({
      id: Type.String(),
      relative_path: Type.String(),
      source: StringEnum(['project', 'local']),
      conditional: Type.Boolean(),
      content_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    })
  ),
  trigger_paths: Type.Array(Type.String()),
  blocked_write: Type.Boolean(),
});

const UserShellStartedEventSchema = event({
  type: Type.Literal('user_shell_started'),
  execution_id: Type.String(),
  command: Type.String(),
  auxiliary: Type.Boolean(),
});

const UserShellOutputEventSchema = event({
  type: Type.Literal('user_shell_output'),
  execution_id: Type.String(),
  stream: StringEnum(['stdout', 'stderr']),
  chunk: Type.String(),
  stream_truncated: Type.Boolean(),
});

const UserShellCompletedEventSchema = event({
  type: Type.Literal('user_shell_completed'),
  execution_id: Type.String(),
  message_id: Type.String(),
  status: StringEnum(['completed', 'failed', 'aborted', 'timed_out', 'spawn_error']),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  duration_ms: Type.Number({ minimum: 0 }),
  stdout: Type.String(),
  stderr: Type.String(),
  truncated: Type.Boolean(),
  auxiliary: Type.Boolean(),
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

const GoalEventSchema = event({
  type: Type.Literal('goal'),
  state: StringEnum(['updated', 'cleared']),
  goal_id: Type.Optional(Type.String()),
  status: Type.Optional(
    StringEnum([
      'active',
      'verifying',
      'paused',
      'blocked',
      'usage_limited',
      'budget_limited',
      'complete',
    ])
  ),
  verification_attempt: Type.Optional(Type.Integer({ minimum: 1 })),
  verification_status: Type.Optional(
    StringEnum(['pending', 'pass', 'fail', 'partial'])
  ),
  verifier_session_id: Type.Optional(Type.String()),
  verification_evidence_sha256: Type.Optional(
    Type.String({ pattern: '^[a-f0-9]{64}$' })
  ),
});

const SubagentEventSchema = event({
  type: Type.Literal('subagent'),
  state: StringEnum(['spawned', 'completed']),
  session_id: Type.String(),
  subagent_type: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  summary: Type.Optional(Type.String()),
  verification_verdict: Type.Optional(StringEnum(['pass', 'fail', 'partial'])),
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
  reason: Type.Optional(
    StringEnum(['threshold', 'context_limit', 'turn_limit', 'manual'])
  ),
  strategy: Type.Optional(StringEnum(['llm', 'fallback', 'snip'])),
  outcome: Type.Optional(StringEnum(['completed', 'fallback', 'failed'])),
  pre_tokens: Type.Optional(Type.Number({ minimum: 0 })),
  post_tokens: Type.Optional(Type.Number({ minimum: 0 })),
});

const ProviderRetryEventSchema = event({
  type: Type.Literal('provider_retry'),
  phase: StringEnum(['scheduled', 'attempt', 'recovered', 'exhausted']),
  attempt: Type.Integer({ minimum: 0 }),
  max_retries: Type.Integer({ minimum: 0 }),
  reason: StringEnum([
    'rate_limit',
    'server_error',
    'timeout',
    'transport',
    'stream_closed',
  ]),
  status_code: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  delay_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  next_retry_at: Type.Optional(Type.Integer({ minimum: 0 })),
});

const ProviderStallEventSchema = event({
  type: Type.Literal('provider_stall'),
  phase: StringEnum(['detected', 'recovered']),
  stall_count: Type.Integer({ minimum: 1 }),
  duration_ms: Type.Integer({ minimum: 0 }),
  warning_after_ms: Type.Integer({ minimum: 1 }),
  timeout_ms: Type.Integer({ minimum: 1 }),
  output_started: Type.Boolean(),
});

const ActionStationarityEventSchema = event({
  type: Type.Literal('action_stationarity'),
  phase: StringEnum(['detected', 'recovered', 'halted']),
  tool_name: Type.String(),
  run_length: Type.Integer({ minimum: 1 }),
  nudge_threshold: Type.Integer({ minimum: 1 }),
  halt_threshold: Type.Integer({ minimum: 1 }),
  progress_aware: Type.Boolean(),
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

const TaskAdmissionEventSchema = event({
  type: Type.Literal('task_admission'),
  state: StringEnum(['queued', 'running']),
  queue_position: Type.Optional(Type.Integer({ minimum: 1 })),
  queue_depth: Type.Integer({ minimum: 0 }),
  in_flight: Type.Integer({ minimum: 0 }),
  max_concurrent_tasks: Type.Integer({ minimum: 1 }),
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
    StructuredOutputEventSchema,
    ToolStartEventSchema,
    ToolProgressEventSchema,
    ToolResultEventSchema,
    McpCatalogChangedEventSchema,
    McpContentChangedEventSchema,
    McpResourceUpdatedEventSchema,
    McpConnectionChangedEventSchema,
    McpLogEventSchema,
    McpInstructionsChangedEventSchema,
    McpTaskChangedEventSchema,
    ProjectRulesLoadedEventSchema,
    UserShellStartedEventSchema,
    UserShellOutputEventSchema,
    UserShellCompletedEventSchema,
    PhaseEventSchema,
    ToolDetailEventSchema,
    TaskUpdateEventSchema,
    GoalEventSchema,
    SubagentEventSchema,
    TokenUsageEventSchema,
    CompactingEventSchema,
    ProviderRetryEventSchema,
    ProviderStallEventSchema,
    ActionStationarityEventSchema,
    TurnLimitEventSchema,
    TaskSessionEventSchema,
    TaskAdmissionEventSchema,
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
