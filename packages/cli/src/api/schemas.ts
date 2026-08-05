import { Default, Runtime, type Static, StringEnum, Type } from '../schema/index.js';

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
    taskStartedAt: Type.Optional(Type.String()),
    taskCompletedAt: Type.Optional(Type.String()),
    messageCount: Type.Number(),
    firstMessageTime: Type.String(),
    lastMessageTime: Type.String(),
    hasErrors: Type.Boolean(),
  })
);
export type Session = Static<typeof SessionSchema>;

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

export const BusEventSchema = Runtime(
  Type.Object({
    type: Type.String(),
    properties: Type.Record(Type.String(), Type.Unknown()),
  })
);
export type BusEvent = Static<typeof BusEventSchema>;

export const SendMessageRequestSchema = Runtime(
  Type.Object({
    content: Type.String(),
    projectPath: Type.Optional(Type.String()),
    permissionMode: Type.Optional(PermissionModeSchema),
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          type: StringEnum(['file', 'image', 'url']),
          path: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          content: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
        })
      )
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
