import { Default, Runtime, type Static, StringEnum, Type } from '../schema/index.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from './attachmentLimits.js';

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

export const SessionPendingInteractionSchema = Runtime(
  Type.Object({
    type: StringEnum(['permission', 'question']),
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
      'runtime',
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    retryable: Type.Boolean(),
  })
);
export type SessionTaskFailure = Static<typeof SessionTaskFailureSchema>;

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
    taskModelId: Type.Optional(Type.String()),
    selectedModelId: Type.Optional(Type.String()),
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

export const GoalSchema = Runtime(
  Type.Object({
    version: Type.Literal(1),
    sessionId: Type.String(),
    goalId: Type.String(),
    objective: Type.String(),
    status: StringEnum([
      'active',
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
    rootAgentId: Type.String(),
    resumedFrom: Type.Optional(Type.String()),
    resumeDepth: Type.Integer({ minimum: 0 }),
    createdAt: Type.Number(),
    lastActiveAt: Type.Number(),
    completedAt: Type.Optional(Type.Number()),
    result: Type.Optional(
      Type.Object({
        success: Type.Boolean(),
        message: Type.String(),
        error: Type.Optional(Type.String()),
        verificationCommands: Type.Optional(Type.Array(Type.String())),
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

export const CreateTaskRequestSchema = Runtime(
  Type.Object({
    prompt: Type.String({
      minLength: 1,
      maxLength: 32_000,
      pattern: '\\S',
    }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    projectPath: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    isolation: Default(SessionTaskIsolationSchema, 'worktree'),
    permissionMode: Default(PermissionModeSchema, 'default'),
    attachments: Type.Optional(
      Type.Array(TaskAttachmentSchema, { maxItems: MAX_INLINE_ATTACHMENT_COUNT })
    ),
  })
);
export type CreateTaskRequest = Static<typeof CreateTaskRequestSchema>;

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

export const SendMessageRequestSchema = Runtime(
  Type.Object({
    content: Type.String({ maxLength: MAX_USER_MESSAGE_TEXT_CHARS }),
    projectPath: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    permissionMode: Type.Optional(PermissionModeSchema),
    attachments: Type.Optional(
      Type.Array(TaskAttachmentSchema, { maxItems: MAX_INLINE_ATTACHMENT_COUNT })
    ),
  })
);
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

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
  })
);
export type PermissionResponse = Static<typeof PermissionResponseSchema>;

export const ModelConfigSchema = Runtime(
  Type.Object({
    id: Type.String(),
    displayName: Type.Optional(Type.String()),
    provider: Type.String(),
    model: Type.String(),
    contextWindow: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(StringEnum(['text', 'image']))),
    overrides: Type.Optional(
      Type.Object({
        baseUrl: Type.Optional(Type.String()),
        temperature: Type.Optional(Type.Number()),
        maxOutputTokens: Type.Optional(Type.Number()),
        timeout: Type.Optional(Type.Number()),
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
    theme: Type.String(),
    uiTheme: UiThemeSchema,
    autoSaveSessions: Type.Boolean(),
    notifyBuild: Type.Boolean(),
    notifyErrors: Type.Boolean(),
    notifySounds: Type.Boolean(),
    privacyTelemetry: Type.Boolean(),
    privacyCrash: Type.Boolean(),
  })
);
export type GeneralSettings = Static<typeof GeneralSettingsSchema>;

export const GeneralSettingsUpdateSchema = Runtime(Type.Partial(GeneralSettingsSchema));
export type GeneralSettingsUpdate = Static<typeof GeneralSettingsUpdateSchema>;
