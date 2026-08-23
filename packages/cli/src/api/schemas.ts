import type { GoalPrematureStopPattern } from '../goals/types.js';
import { Default, Runtime, type Static, StringEnum, Type } from '../schema/index.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from './attachmentLimits.js';
import { MAX_SIDE_QUESTION_CHARS } from './sideConversation.js';

export { parseSchema } from '../schema/index.js';
export { Type };

export const PermissionModeSchema = Runtime(
  StringEnum(['default', 'autoEdit', 'yolo', 'plan'])
);
export type PermissionMode = Static<typeof PermissionModeSchema>;

export const PermissionModeEnum = {
  DEFAULT: 'default',
  AUTO_EDIT: 'autoEdit',
  YOLO: 'yolo',
  PLAN: 'plan',
} as const;

export const MessageRoleSchema = Runtime(
  StringEnum(['user', 'assistant', 'system', 'tool'])
);
export type MessageRole = Static<typeof MessageRoleSchema>;

export const MessageContentPartSchema = Runtime(
  Type.Union([
    Type.Object({
      type: Type.Literal('text'),
      text: Type.String(),
    }),
    Type.Object({
      type: Type.Literal('image_url'),
      image_url: Type.Object({
        url: Type.String(),
      }),
    }),
  ])
);

const MessageContentSchema = Type.Union([
  Type.String(),
  Type.Array(MessageContentPartSchema),
]);

export const MessageSchema = Runtime(
  Type.Object({
    id: Type.String(),
    role: MessageRoleSchema,
    content: MessageContentSchema,
    timestamp: Type.Number(),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    thinkingContent: Type.Optional(Type.String()),
    tool_call_id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    tool_calls: Type.Optional(Type.Unknown()),
  })
);
export type Message = Static<typeof MessageSchema>;

export const SessionTaskStatusSchema = Runtime(
  StringEnum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
);
export type SessionTaskStatus = Static<typeof SessionTaskStatusSchema>;

export const SessionTaskIsolationSchema = Runtime(StringEnum(['local', 'worktree']));
export type SessionTaskIsolation = Static<typeof SessionTaskIsolationSchema>;

export const SessionTaskPrioritySchema = Runtime(StringEnum(['high', 'medium', 'low']));
export type SessionTaskPriority = Static<typeof SessionTaskPrioritySchema>;

export const SessionTaskKindSchema = Runtime(
  StringEnum(['feature', 'bug', 'maintenance', 'research'])
);
export type SessionTaskKind = Static<typeof SessionTaskKindSchema>;

export const SessionTaskDeliveryStatusSchema = Runtime(
  StringEnum(['applied', 'discarded', 'conflicted'])
);
export type SessionTaskDeliveryStatus = Static<typeof SessionTaskDeliveryStatusSchema>;

export const SessionTaskDeliverySchema = Runtime(
  Type.Object({
    status: SessionTaskDeliveryStatusSchema,
    updatedAt: Type.String(),
    sourceCommit: Type.Optional(Type.String()),
    changedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    message: Type.Optional(Type.String()),
  })
);
export type SessionTaskDelivery = Static<typeof SessionTaskDeliverySchema>;

export const SessionTaskDiffStatSchema = Runtime(
  Type.Object({
    changedFiles: Type.Integer({ minimum: 0 }),
    additions: Type.Integer({ minimum: 0 }),
    deletions: Type.Integer({ minimum: 0 }),
    commits: Type.Integer({ minimum: 0 }),
  })
);
export type SessionTaskDiffStat = Static<typeof SessionTaskDiffStatSchema>;

export const SessionTaskDiffFileSchema = Runtime(
  Type.Object({
    path: Type.String({ minLength: 1 }),
    patch: Type.String({ maxLength: 2 * 1024 * 1024 }),
    additions: Type.Integer({ minimum: 0 }),
    deletions: Type.Integer({ minimum: 0 }),
    binary: Type.Boolean(),
    truncated: Type.Boolean(),
  })
);
export type SessionTaskDiffFile = Static<typeof SessionTaskDiffFileSchema>;

export const SessionTaskDiffArtifactSchema = Runtime(
  Type.Object({
    sessionId: Type.String(),
    projectPath: Type.String(),
    baseCommit: Type.String(),
    files: Type.Array(SessionTaskDiffFileSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  })
);
export type SessionTaskDiffArtifact = Static<typeof SessionTaskDiffArtifactSchema>;

export const McpElicitationContentValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
]);
export type McpElicitationContentValue = Static<
  typeof McpElicitationContentValueSchema
>;

export const McpElicitationFieldSchema = Runtime(
  Type.Object({
    name: Type.String(),
    type: StringEnum([
      'string',
      'number',
      'integer',
      'boolean',
      'select',
      'multi-select',
    ]),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    required: Type.Boolean(),
    defaultValue: Type.Optional(McpElicitationContentValueSchema),
    options: Type.Optional(
      Type.Array(
        Type.Object({
          value: Type.String(),
          label: Type.String(),
        })
      )
    ),
    format: Type.Optional(StringEnum(['date', 'uri', 'email', 'date-time'])),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    minLength: Type.Optional(Type.Number()),
    maxLength: Type.Optional(Type.Number()),
    minItems: Type.Optional(Type.Number()),
    maxItems: Type.Optional(Type.Number()),
  })
);
export type McpElicitationField = Static<typeof McpElicitationFieldSchema>;

export const McpElicitationDetailsSchema = Runtime(
  Type.Object({
    serverName: Type.String(),
    mode: StringEnum(['form', 'url']),
    message: Type.String(),
    fields: Type.Optional(Type.Array(McpElicitationFieldSchema)),
    requestedSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    url: Type.Optional(Type.String()),
    domain: Type.Optional(Type.String()),
    elicitationId: Type.Optional(Type.String()),
  })
);
export type McpElicitationDetails = Static<typeof McpElicitationDetailsSchema>;

export const SessionPendingInteractionSchema = Runtime(
  Type.Object({
    type: StringEnum(['permission', 'question', 'elicitation']),
    requestId: Type.String(),
  })
);
export type SessionPendingInteraction = Static<typeof SessionPendingInteractionSchema>;

export const SessionTaskFailureSchema = Runtime(
  Type.Object({
    code: StringEnum([
      'authentication',
      'permission',
      'rate_limit',
      'timeout',
      'network',
      'model_unavailable',
      'context_limit',
      'unsupported_input',
      'capacity',
      'runtime',
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    retryable: Type.Boolean(),
    resource: Type.Optional(
      StringEnum(['pending_count', 'pending_bytes', 'resident_runtimes'])
    ),
  })
);
export type SessionTaskFailure = Static<typeof SessionTaskFailureSchema>;

export const ReasoningEffortSchema = Runtime(
  StringEnum(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
);
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;

export const ServiceTierSchema = Runtime(
  StringEnum(['auto', 'standard', 'fast', 'flex'])
);
export type ServiceTier = Static<typeof ServiceTierSchema>;

export const ResponseVerbositySchema = Runtime(
  StringEnum(['auto', 'low', 'medium', 'high'])
);
export type ResponseVerbosity = Static<typeof ResponseVerbositySchema>;

export const CommunicationStyleSchema = Runtime(
  Type.Union([
    StringEnum(['auto', 'pragmatic', 'friendly', 'explanatory']),
    Type.String({
      minLength: 7,
      maxLength: 300,
      pattern:
        '^(?:(?:user|project):[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63}){0,3}|plugin:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63}){0,3})$',
    }),
  ])
);
export type CommunicationStyle = Static<typeof CommunicationStyleSchema>;

export const SessionSchema = Runtime(
  Type.Object({
    sessionId: Type.String(),
    projectPath: Type.String(),
    title: Type.Optional(Type.String()),
    gitBranch: Type.Optional(Type.String()),
    rootId: Type.String(),
    parentId: Type.Optional(Type.String()),
    relationType: Type.Optional(StringEnum(['subagent', 'fork'])),
    resumedFrom: Type.Optional(Type.String()),
    rootAgentId: Type.Optional(Type.String()),
    resumeDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    taskStatus: Default(SessionTaskStatusSchema, 'completed'),
    taskStatusReason: Type.Optional(Type.String()),
    taskFailure: Type.Optional(SessionTaskFailureSchema),
    taskStartedAt: Type.Optional(Type.String()),
    taskCompletedAt: Type.Optional(Type.String()),
    taskPromptSummary: Type.Optional(Type.String()),
    taskPriority: Type.Optional(SessionTaskPrioritySchema),
    taskKind: Type.Optional(SessionTaskKindSchema),
    taskDueAt: Type.Optional(Type.String()),
    taskModelId: Type.Optional(Type.String()),
    selectedModelId: Type.Optional(Type.String()),
    permissionMode: Type.Optional(PermissionModeSchema),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    communicationStyleDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    projectInstructionsDigest: Type.Optional(
      Type.String({ pattern: '^[a-f0-9]{64}$' })
    ),
    taskRetryAvailable: Type.Optional(Type.Boolean()),
    taskRetriedFrom: Type.Optional(
      Type.Object({
        sessionId: Type.String(),
        projectPath: Type.String(),
      })
    ),
    taskDelivery: Type.Optional(SessionTaskDeliverySchema),
    taskIsolation: Type.Optional(SessionTaskIsolationSchema),
    taskSourceProjectPath: Type.Optional(Type.String()),
    taskWorktreePath: Type.Optional(Type.String()),
    taskWorktreeBranch: Type.Optional(Type.String()),
    taskBaseCommit: Type.Optional(Type.String()),
    taskDiffStat: Type.Optional(SessionTaskDiffStatSchema),
    taskQueuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
    taskQueueDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    taskConcurrencyLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    archivedAt: Type.Optional(Type.String()),
    archivedBySessionId: Type.Optional(Type.String()),
    pendingInteraction: Type.Optional(SessionPendingInteractionSchema),
    messageCount: Type.Number(),
    firstMessageTime: Type.String(),
    lastMessageTime: Type.String(),
    hasErrors: Type.Boolean(),
  })
);
export type Session = Static<typeof SessionSchema>;

export const SessionCatalogPageSchema = Runtime(
  Type.Object({
    sessions: Type.Array(SessionSchema),
    nextCursor: Type.Optional(Type.String()),
  })
);
export type SessionCatalogPage = Static<typeof SessionCatalogPageSchema>;

export const SessionArchiveResponseSchema = Runtime(
  Type.Object({
    session: SessionSchema,
    archivedSessionIds: Type.Array(Type.String()),
  })
);
export type SessionArchiveResponse = Static<typeof SessionArchiveResponseSchema>;

export const SessionUnarchiveResponseSchema = Runtime(
  Type.Object({
    session: SessionSchema,
    restoredSessionIds: Type.Array(Type.String()),
  })
);
export type SessionUnarchiveResponse = Static<typeof SessionUnarchiveResponseSchema>;

export const GoalSchema = Runtime(
  Type.Object({
    version: Type.Literal(1),
    sessionId: Type.String(),
    goalId: Type.String(),
    objective: Type.String(),
    status: StringEnum([
      'active',
      'verifying',
      'paused',
      'blocked',
      'usage_limited',
      'budget_limited',
      'complete',
    ]),
    tokenBudget: Type.Optional(Type.Number()),
    tokensUsed: Type.Number(),
    timeUsedSeconds: Type.Number(),
    continuationCount: Type.Number(),
    statusReason: Type.Optional(Type.String()),
    completionVerification: Type.Optional(
      Type.Object({
        attempt: Type.Integer({ minimum: 1 }),
        status: StringEnum(['pending', 'pass', 'fail', 'partial']),
        requestedAt: Type.String(),
        completedAt: Type.Optional(Type.String()),
        verifierSessionId: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        evidenceSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
      })
    ),
    prematureStop: Type.Optional(
      Type.Object({
        pattern: Type.Unsafe<GoalPrematureStopPattern>({ type: 'string' }),
        consecutiveCount: Type.Integer({ minimum: 1 }),
        detectedAt: Type.String(),
      })
    ),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  })
);
export type Goal = Static<typeof GoalSchema>;

export const SessionHistoryMessageSchema = Runtime(
  Type.Object({
    role: MessageRoleSchema,
    content: MessageContentSchema,
    metadata: Type.Optional(Type.Unknown()),
    reasoningContent: Type.Optional(Type.String()),
    thinkingContent: Type.Optional(Type.String()),
    tool_call_id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    tool_calls: Type.Optional(Type.Unknown()),
  })
);
export type SessionHistoryMessage = Static<typeof SessionHistoryMessageSchema>;

export const ForkSessionResponseSchema = Runtime(
  Type.Object({
    session: SessionSchema,
    messages: Type.Array(SessionHistoryMessageSchema),
  })
);
export type ForkSessionResponse = Static<typeof ForkSessionResponseSchema>;

export const SessionRewindModeSchema = Runtime(
  StringEnum(['conversation', 'code', 'both'])
);
export type SessionRewindMode = Static<typeof SessionRewindModeSchema>;

export const SessionRewindCheckpointSchema = Runtime(
  Type.Object({
    messageId: Type.String(),
    preview: Type.String(),
    createdAt: Type.String(),
    fileCount: Type.Integer({ minimum: 0 }),
  })
);
export type SessionRewindCheckpoint = Static<typeof SessionRewindCheckpointSchema>;

export const SessionRewindRequestSchema = Runtime(
  Type.Object({
    targetMessageId: Type.String({ minLength: 1 }),
    mode: Default(SessionRewindModeSchema, 'conversation'),
  })
);
export type SessionRewindRequest = Static<typeof SessionRewindRequestSchema>;

export const SessionRewindResponseSchema = Runtime(
  Type.Object({
    checkpoint: SessionRewindCheckpointSchema,
    mode: SessionRewindModeSchema,
    removedTurns: Type.Integer({ minimum: 1 }),
    restoredFiles: Type.Array(Type.String()),
    messages: Type.Array(SessionHistoryMessageSchema),
  })
);
export type SessionRewindResponse = Static<typeof SessionRewindResponseSchema>;

export const SubagentStatusSchema = StringEnum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const SubagentSessionSchema = Runtime(
  Type.Object({
    id: Type.String(),
    subagentType: Type.String(),
    description: Type.String(),
    status: SubagentStatusSchema,
    background: Type.Boolean(),
    rootAgentId: Type.String(),
    resumedFrom: Type.Optional(Type.String()),
    resumeDepth: Type.Integer({ minimum: 0 }),
    createdAt: Type.Number(),
    lastActiveAt: Type.Number(),
    completedAt: Type.Optional(Type.Number()),
    restartRecovery: Type.Optional(
      Type.Object({
        outcome: StringEnum(['completed', 'interrupted', 'failed']),
        recoveredAt: Type.Number(),
      })
    ),
    result: Type.Optional(
      Type.Object({
        success: Type.Boolean(),
        message: Type.String(),
        error: Type.Optional(Type.String()),
        verificationCommands: Type.Optional(Type.Array(Type.String())),
        verificationVerdict: Type.Optional(StringEnum(['pass', 'fail', 'partial'])),
        modifiedFiles: Type.Optional(Type.Array(Type.String())),
      })
    ),
    stats: Type.Optional(
      Type.Object({
        tokens: Type.Optional(Type.Number()),
        toolCalls: Type.Optional(Type.Number()),
        duration: Type.Optional(Type.Number()),
      })
    ),
  })
);
export type SubagentSession = Static<typeof SubagentSessionSchema>;

export const ResumeSubagentRequestSchema = Runtime(
  Type.Object({
    prompt: Type.String({ minLength: 1, maxLength: 32_000, pattern: '\\S' }),
  })
);

export const ResumeSubagentResponseSchema = Runtime(
  Type.Object({
    source: SubagentSessionSchema,
    session: SubagentSessionSchema,
  })
);
export type ResumeSubagentResponse = Static<typeof ResumeSubagentResponseSchema>;

export const SessionRefSchema = Runtime(
  Type.Object({
    sessionId: Type.String(),
    projectPath: Type.String(),
  })
);
export type SessionRef = Static<typeof SessionRefSchema>;

export const BoundProjectSchema = Runtime(
  Type.Object({
    path: Type.String(),
    name: Type.String(),
    gitBranch: Type.Optional(Type.String()),
    available: Type.Boolean(),
    isCurrent: Type.Boolean(),
    boundAt: Type.String(),
  })
);
export type BoundProject = Static<typeof BoundProjectSchema>;

export const ProjectDirectorySelectionSchema = Runtime(
  Type.Union([
    Type.Object({
      cancelled: Type.Literal(true),
    }),
    Type.Object({
      cancelled: Type.Literal(false),
      path: Type.String({ minLength: 1 }),
    }),
  ])
);
export type ProjectDirectorySelection = Static<typeof ProjectDirectorySelectionSchema>;

export const BusEventSchema = Runtime(
  Type.Object({
    type: Type.String(),
    // Monotonic seq for durable committed events; absent for ephemeral events.
    seq: Type.Optional(Type.Number()),
    properties: Type.Record(Type.String(), Type.Unknown()),
  })
);
export type BusEvent = Static<typeof BusEventSchema>;

export const TaskAttachmentSchema = Type.Object({
  type: StringEnum(['file', 'image', 'url']),
  path: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  content: Type.Optional(Type.String({ maxLength: MAX_INLINE_ATTACHMENT_BYTES })),
  mimeType: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});

export const OutputSchemaSchema = Type.Record(Type.String(), Type.Unknown());

export const CreateTaskRequestSchema = Runtime(
  Type.Object({
    prompt: Type.String({
      minLength: 1,
      maxLength: 32_000,
      pattern: '\\S',
    }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    taskPriority: Default(SessionTaskPrioritySchema, 'medium'),
    taskKind: Default(SessionTaskKindSchema, 'feature'),
    taskDueAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    projectPath: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    isolation: Default(SessionTaskIsolationSchema, 'worktree'),
    permissionMode: Default(PermissionModeSchema, 'default'),
    attachments: Type.Optional(
      Type.Array(TaskAttachmentSchema, { maxItems: MAX_INLINE_ATTACHMENT_COUNT })
    ),
    outputSchema: Type.Optional(OutputSchemaSchema),
  })
);
export type CreateTaskRequest = Static<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = Runtime(
  Type.Object({
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    taskPriority: Type.Optional(SessionTaskPrioritySchema),
    taskKind: Type.Optional(SessionTaskKindSchema),
    taskDueAt: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])
    ),
  })
);
export type UpdateTaskRequest = Static<typeof UpdateTaskRequestSchema>;

export const CreateTaskResponseSchema = Runtime(
  Type.Object({
    session: SessionSchema,
    runId: Type.String(),
    messageId: Type.String(),
    status: StringEnum(['queued', 'running']),
    queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
    queueDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    maxConcurrentTasks: Type.Optional(Type.Integer({ minimum: 1 })),
  })
);
export type CreateTaskResponse = Static<typeof CreateTaskResponseSchema>;

export const SessionTaskDeliveryRequestSchema = Runtime(
  Type.Object({
    action: StringEnum(['apply', 'discard']),
  })
);
export type SessionTaskDeliveryRequest = Static<
  typeof SessionTaskDeliveryRequestSchema
>;

// ── Scheduled tasks ───────────────────────────────────────────────────────────
// A schedule fires a headless task run on a cron/interval/one-shot trigger.
// The trigger is normalized to a cron expression + timezone for recurring
// schedules, or an ISO timestamp for one-shot schedules. Dispatch options
// mirror the CreateTask contract so a fired schedule reuses the same run path.

export const ScheduleTriggerSchema = Runtime(
  Type.Object({
    kind: StringEnum(['cron', 'interval', 'once']),
    // cron: standard 5-field expression (min hour dom mon dow), local timezone.
    cron: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    // interval: milliseconds between runs (normalized from Ns/Nm/Nh/Nd input).
    intervalMs: Type.Optional(Type.Integer({ minimum: 60_000 })),
    // once: ISO-8601 timestamp of the single future run.
    runAt: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    // IANA timezone the cron/interval is interpreted in; defaults to the host.
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  })
);
export type ScheduleTrigger = Static<typeof ScheduleTriggerSchema>;

export const ScheduleDispatchSchema = Runtime(
  Type.Object({
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    isolation: Default(SessionTaskIsolationSchema, 'worktree'),
    permissionMode: Default(PermissionModeSchema, 'default'),
  })
);
export type ScheduleDispatch = Static<typeof ScheduleDispatchSchema>;

export const ScheduleSchema = Runtime(
  Type.Object({
    id: Type.String(),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    prompt: Type.String({ minLength: 1, maxLength: 32_000, pattern: '\\S' }),
    projectPath: Type.String({ minLength: 1 }),
    trigger: ScheduleTriggerSchema,
    dispatch: ScheduleDispatchSchema,
    enabled: Type.Boolean(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    // Next fire time (ISO) computed from the trigger; null when finished.
    nextRunAt: Type.Union([Type.String(), Type.Null()]),
    // Recurring schedules auto-expire (ISO); null for one-shot / no expiry.
    expiresAt: Type.Union([Type.String(), Type.Null()]),
    lastRunAt: Type.Optional(Type.String()),
    lastRunSessionId: Type.Optional(Type.String()),
    lastStatus: Type.Optional(
      StringEnum([
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'error',
      ])
    ),
    lastError: Type.Optional(Type.String()),
    runCount: Type.Integer({ minimum: 0 }),
  })
);
export type Schedule = Static<typeof ScheduleSchema>;

export const CreateScheduleRequestSchema = Runtime(
  Type.Object({
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    prompt: Type.String({ minLength: 1, maxLength: 32_000, pattern: '\\S' }),
    projectPath: Type.String({ minLength: 1 }),
    trigger: ScheduleTriggerSchema,
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    isolation: Default(SessionTaskIsolationSchema, 'worktree'),
    permissionMode: Default(PermissionModeSchema, 'default'),
    enabled: Default(Type.Boolean(), true),
  })
);
export type CreateScheduleRequest = Static<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = Runtime(
  Type.Object({
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    prompt: Type.Optional(
      Type.String({ minLength: 1, maxLength: 32_000, pattern: '\\S' })
    ),
    trigger: Type.Optional(ScheduleTriggerSchema),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    isolation: Type.Optional(SessionTaskIsolationSchema),
    permissionMode: Type.Optional(PermissionModeSchema),
    enabled: Type.Optional(Type.Boolean()),
  })
);
export type UpdateScheduleRequest = Static<typeof UpdateScheduleRequestSchema>;

export const ScheduleListResponseSchema = Runtime(
  Type.Object({
    schedules: Type.Array(ScheduleSchema),
  })
);
export type ScheduleListResponse = Static<typeof ScheduleListResponseSchema>;

export const SendMessageRequestSchema = Runtime(
  Type.Object({
    content: Type.String({ maxLength: MAX_USER_MESSAGE_TEXT_CHARS }),
    projectPath: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reasoningEffort: Type.Optional(ReasoningEffortSchema),
    serviceTier: Type.Optional(ServiceTierSchema),
    responseVerbosity: Type.Optional(ResponseVerbositySchema),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
    permissionMode: Type.Optional(PermissionModeSchema),
    attachments: Type.Optional(
      Type.Array(TaskAttachmentSchema, { maxItems: MAX_INLINE_ATTACHMENT_COUNT })
    ),
    outputSchema: Type.Optional(OutputSchemaSchema),
  })
);
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const UserShellCommandStatusSchema = StringEnum([
  'completed',
  'failed',
  'aborted',
  'timed_out',
  'spawn_error',
]);

export const UserShellCommandRecordSchema = Runtime(
  Type.Object({
    version: Type.Literal(1),
    command: Type.String(),
    status: UserShellCommandStatusSchema,
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    durationMs: Type.Number({ minimum: 0 }),
    stdout: Type.String(),
    stderr: Type.String(),
    stdoutOmittedBytes: Type.Integer({ minimum: 0 }),
    stderrOmittedBytes: Type.Integer({ minimum: 0 }),
    binaryOutput: Type.Boolean(),
    truncated: Type.Boolean(),
  })
);
export type UserShellCommandRecord = Static<typeof UserShellCommandRecordSchema>;

export const UserShellCommandRequestSchema = Runtime(
  Type.Object({
    command: Type.String({
      minLength: 1,
      maxLength: 32 * 1024,
      pattern: '^(?![\\s\\S]*\\u0000)(?=[\\s\\S]*\\S)[\\s\\S]*$',
    }),
    projectPath: Type.Optional(Type.String()),
  })
);
export type UserShellCommandRequest = Static<typeof UserShellCommandRequestSchema>;

export const UserShellCommandResponseSchema = Runtime(
  Type.Object({
    executionId: Type.String(),
    messageId: Type.String(),
    record: UserShellCommandRecordSchema,
    auxiliary: Type.Boolean(),
    delivery: Type.Optional(StringEnum(['current_turn', 'next_turn'])),
    queued: Type.Optional(Type.Integer({ minimum: 0 })),
  })
);
export type UserShellCommandResponse = Static<typeof UserShellCommandResponseSchema>;

export const SideConversationRequestSchema = Runtime(
  Type.Object({
    question: Type.String({
      minLength: 1,
      maxLength: MAX_SIDE_QUESTION_CHARS,
      pattern: '^(?![\\s\\S]*\\x00)(?=[\\s\\S]*\\S)[\\s\\S]*$',
    }),
    projectPath: Type.Optional(Type.String()),
  })
);
export type SideConversationRequest = Static<typeof SideConversationRequestSchema>;

export const SideConversationResponseSchema = Runtime(
  Type.Object({
    response: Type.String({ minLength: 1 }),
    durationMs: Type.Number({ minimum: 0 }),
    modelId: Type.Optional(Type.String()),
    usage: Type.Optional(
      Type.Object({
        promptTokens: Type.Number({ minimum: 0 }),
        completionTokens: Type.Number({ minimum: 0 }),
        totalTokens: Type.Number({ minimum: 0 }),
        reasoningTokens: Type.Optional(Type.Number({ minimum: 0 })),
        cacheCreationInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
        cacheReadInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
        costUsd: Type.Optional(Type.Number({ minimum: 0 })),
      })
    ),
  })
);

export type SideConversationResponse = Static<typeof SideConversationResponseSchema>;

export const CodeReviewRequestSchema = Runtime(
  Type.Object({
    projectPath: Type.String(),
    kind: StringEnum(['uncommitted', 'base', 'commit']),
    ref: Type.Optional(Type.String({ maxLength: 200 })),
    instructions: Type.Optional(Type.String({ maxLength: 4_000 })),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  })
);
export type CodeReviewRequest = Static<typeof CodeReviewRequestSchema>;

export const CodeReviewStartResponseSchema = Runtime(
  Type.Object({
    reviewId: Type.String(),
    status: Type.Literal('running'),
  })
);
export type CodeReviewStartResponse = Static<typeof CodeReviewStartResponseSchema>;

export const SendMessageResponseSchema = Runtime(
  Type.Object({
    messageId: Type.String(),
    role: MessageRoleSchema,
    content: Type.String(),
    timestamp: Type.String(),
  })
);
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

export const PermissionResponseSchema = Runtime(
  Type.Object({
    approved: Type.Boolean(),
    remember: Type.Optional(Type.Boolean()),
    scope: Type.Optional(StringEnum(['once', 'session', 'project'])),
    targetMode: Type.Optional(PermissionModeSchema),
    feedback: Type.Optional(Type.String()),
    answers: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]))
    ),
    elicitation: Type.Optional(
      Type.Object({
        action: StringEnum(['accept', 'decline', 'cancel']),
        content: Type.Optional(
          Type.Record(
            Type.String(),
            Type.Union([
              Type.String({ maxLength: 4_000 }),
              Type.Number(),
              Type.Boolean(),
              Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 }),
            ]),
            { maxProperties: 32 }
          )
        ),
      })
    ),
  })
);
export type PermissionResponse = Static<typeof PermissionResponseSchema>;

export const CommunicationStyleSummarySchema = Runtime(
  Type.Object({
    id: CommunicationStyleSchema,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.String({ minLength: 1, maxLength: 256 }),
    source: StringEnum(['built-in', 'user', 'project', 'plugin']),
    contentSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  })
);
export type CommunicationStyleSummary = Static<typeof CommunicationStyleSummarySchema>;

export const ModelConfigSchema = Runtime(
  Type.Object({
    id: Type.String(),
    displayName: Type.Optional(Type.String()),
    provider: Type.String(),
    model: Type.String(),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    reasoning: Type.Optional(Type.Boolean()),
    supportedReasoningEfforts: Type.Optional(
      Type.Array(
        StringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      )
    ),
    supportedServiceTiers: Type.Optional(
      Type.Array(StringEnum(['standard', 'fast', 'flex']))
    ),
    supportedResponseVerbosities: Type.Optional(
      Type.Array(StringEnum(['low', 'medium', 'high']))
    ),
    communicationStyles: Type.Optional(
      Type.Array(CommunicationStyleSummarySchema, { maxItems: 36 })
    ),
    input: Type.Optional(Type.Array(StringEnum(['text', 'image']))),
    overrides: Type.Optional(
      Type.Object({
        baseUrl: Type.Optional(Type.String()),
        temperature: Type.Optional(Type.Number()),
        maxOutputTokens: Type.Optional(Type.Number()),
        timeout: Type.Optional(Type.Number()),
        streamIdleTimeout: Type.Optional(Type.Number({ minimum: 1_000 })),
      })
    ),
  })
);
export type ModelConfig = Static<typeof ModelConfigSchema>;

export const EditorThemeSchema = Runtime(
  StringEnum(['vs-dark', 'vs-light', 'hc-black'])
);
export type EditorTheme = Static<typeof EditorThemeSchema>;

export const UiThemeSchema = Runtime(StringEnum(['light', 'dark', 'system']));
export type UiTheme = Static<typeof UiThemeSchema>;

export const GeneralSettingsSchema = Runtime(
  Type.Object({
    language: Type.String(),
    codeTheme: Type.String(),
    uiTheme: UiThemeSchema,
    autoSaveSessions: Type.Boolean(),
    notifyBuild: Type.Boolean(),
    notifyErrors: Type.Boolean(),
    notifySounds: Type.Boolean(),
    privacyTelemetry: Type.Boolean(),
    privacyCrash: Type.Boolean(),
    agentTeamsEnabled: Type.Boolean(),
    communicationStyle: Type.Optional(CommunicationStyleSchema),
  })
);
export type GeneralSettings = Static<typeof GeneralSettingsSchema>;

export const GeneralSettingsUpdateSchema = Runtime(Type.Partial(GeneralSettingsSchema));
export type GeneralSettingsUpdate = Static<typeof GeneralSettingsUpdateSchema>;
