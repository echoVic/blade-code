import { z } from 'zod';

export const PermissionModeSchema = z.enum(['default', 'autoEdit', 'yolo', 'plan', 'spec']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const PermissionModeEnum = {
  DEFAULT: 'default',
  AUTO_EDIT: 'autoEdit',
  YOLO: 'yolo',
  PLAN: 'plan',
  SPEC: 'spec',
} as const;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.unknown()).optional(),
  thinkingContent: z.string().optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  tool_calls: z.unknown().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const SessionSchema = z.object({
  sessionId: z.string(),
  projectPath: z.string(),
  title: z.string().optional(),
  gitBranch: z.string().optional(),
  messageCount: z.number(),
  firstMessageTime: z.string(),
  lastMessageTime: z.string(),
  hasErrors: z.boolean(),
  filePath: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const BusEventSchema = z.object({
  type: z.string(),
  properties: z.record(z.unknown()),
});
export type BusEvent = z.infer<typeof BusEventSchema>;

export const SendMessageRequestSchema = z.object({
  content: z.string(),
  permissionMode: PermissionModeSchema.optional(),
  attachments: z.array(z.object({
    type: z.enum(['file', 'image', 'url']),
    path: z.string().optional(),
    url: z.string().optional(),
    content: z.string().optional(),
  })).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({
  messageId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  timestamp: z.string(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const PermissionResponseSchema = z.object({
  approved: z.boolean(),
  remember: z.boolean().optional(),
  scope: z.enum(['once', 'session']).optional(),
  targetMode: PermissionModeSchema.optional(),
  feedback: z.string().optional(),
  answers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type PermissionResponse = z.infer<typeof PermissionResponseSchema>;

export const ModelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  maxContextTokens: z.number().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const EditorThemeSchema = z.enum(['vs-dark', 'vs-light', 'hc-black']);
export type EditorTheme = z.infer<typeof EditorThemeSchema>;

export const UiThemeSchema = z.enum(['light', 'dark', 'system']);
export type UiTheme = z.infer<typeof UiThemeSchema>;

export const GeneralSettingsSchema = z.object({
  language: z.string(),
  theme: z.string(),
  uiTheme: UiThemeSchema,
  autoSaveSessions: z.boolean(),
  notifyBuild: z.boolean(),
  notifyErrors: z.boolean(),
  notifySounds: z.boolean(),
  privacyTelemetry: z.boolean(),
  privacyCrash: z.boolean(),
});
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;

export const GeneralSettingsUpdateSchema = GeneralSettingsSchema.partial();
export type GeneralSettingsUpdate = z.infer<typeof GeneralSettingsUpdateSchema>;
