/**
 * Hook System Zod Schemas
 *
 * 用于验证 Hook 输入输出的 Zod Schema
 */

import { z } from 'zod';
import {
  DecisionBehavior,
  HookEvent,
  HookType,
  PermissionDecision,
} from '../types/HookTypes.js';

// ============================================================================
// Hook Input Schemas
// ============================================================================

const HookInputBaseSchema = z.object({
  hook_event_name: z.nativeEnum(HookEvent),
  hook_execution_id: z.string(),
  timestamp: z.string(),
  project_dir: z.string(),
  session_id: z.string(),
  permission_mode: z.enum(['default', 'autoEdit', 'yolo', 'plan']),
  _metadata: z
    .object({
      blade_version: z.string(),
      hook_timeout_ms: z.number(),
    })
    .optional(),
});

const PreToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PreToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
});

const PostToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
  tool_response: z.unknown(),
});

const StopInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Stop),
  reason: z.string().optional(),
});

const PostToolUseFailureInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostToolUseFailure),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
  error: z.string(),
  error_type: z.string().optional(),
  is_interrupt: z.boolean(),
  is_timeout: z.boolean(),
});

const PermissionRequestInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PermissionRequest),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
});

const UserPromptSubmitInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.UserPromptSubmit),
  user_prompt: z.string(),
  has_images: z.boolean(),
  image_count: z.number(),
});

const SessionStartInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SessionStart),
  is_resume: z.boolean(),
  resume_session_id: z.string().optional(),
});

const SessionEndInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SessionEnd),
  reason: z.enum([
    'user_exit',
    'error',
    'max_turns',
    'idle_timeout',
    'ctrl_c',
    'clear',
    'logout',
    'other',
  ]),
});

const SubagentStopInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SubagentStop),
  agent_type: z.string(),
  task_description: z.string().optional(),
  success: z.boolean(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
});

const NotificationInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Notification),
  notification_type: z.enum([
    'permission_prompt',
    'idle_prompt',
    'auth_success',
    'elicitation_dialog',
    'info',
    'warning',
    'error',
  ]),
  title: z.string().optional(),
  message: z.string(),
});

const CompactionInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Compaction),
  trigger: z.enum(['manual', 'auto']),
  messages_before: z.number(),
  tokens_before: z.number(),
});

const _HookInputSchema = z.discriminatedUnion('hook_event_name', [
  PreToolUseInputSchema,
  PostToolUseInputSchema,
  StopInputSchema,
  PostToolUseFailureInputSchema,
  PermissionRequestInputSchema,
  UserPromptSubmitInputSchema,
  SessionStartInputSchema,
  SessionEndInputSchema,
  SubagentStopInputSchema,
  NotificationInputSchema,
  CompactionInputSchema,
]);

// ============================================================================
// Hook Output Schemas
// ============================================================================

const PreToolUseOutputSchema = z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: z.nativeEnum(PermissionDecision).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.unknown()).optional(),
});

const PostToolUseOutputSchema = z.object({
  hookEventName: z.literal('PostToolUse'),
  additionalContext: z.string().optional(),
  updatedOutput: z.unknown().optional(),
});

const StopOutputSchema = z.object({
  hookEventName: z.literal('Stop'),
  continue: z.boolean().optional(),
  continueReason: z.string().optional(),
});

const SubagentStopOutputSchema = z.object({
  hookEventName: z.literal('SubagentStop'),
  continue: z.boolean().optional(),
  continueReason: z.string().optional(),
  additionalContext: z.string().optional(),
});

const PermissionRequestOutputSchema = z.object({
  hookEventName: z.literal('PermissionRequest'),
  permissionDecision: z.enum(['approve', 'deny', 'ask']).optional(),
  permissionDecisionReason: z.string().optional(),
});

const UserPromptSubmitOutputSchema = z.object({
  hookEventName: z.literal('UserPromptSubmit'),
  updatedPrompt: z.string().optional(),
  contextInjection: z.string().optional(),
});

const SessionStartOutputSchema = z.object({
  hookEventName: z.literal('SessionStart'),
  env: z.record(z.string()).optional(),
});

const CompactionOutputSchema = z.object({
  hookEventName: z.literal('Compaction'),
  blockCompaction: z.boolean().optional(),
  blockReason: z.string().optional(),
});

const HookOutputSchema = z.object({
  decision: z
    .object({
      behavior: z.nativeEnum(DecisionBehavior),
    })
    .optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z
    .discriminatedUnion('hookEventName', [
      PreToolUseOutputSchema,
      PostToolUseOutputSchema,
      StopOutputSchema,
      SubagentStopOutputSchema,
      PermissionRequestOutputSchema,
      UserPromptSubmitOutputSchema,
      SessionStartOutputSchema,
      CompactionOutputSchema,
    ])
    .optional(),
  suppressOutput: z.boolean().optional(),
});

// ============================================================================
// Hook Configuration Schemas
// ============================================================================

const CommandHookSchema = z.object({
  type: z.literal(HookType.Command),
  command: z.string(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
});

const PromptHookSchema = z.object({
  type: z.literal(HookType.Prompt),
  prompt: z.string(),
  timeout: z.number().positive().optional(),
});

const HookSchema = z.discriminatedUnion('type', [CommandHookSchema, PromptHookSchema]);

// 支持字符串或字符串数组
const StringOrArraySchema = z.union([z.string(), z.array(z.string())]);

const MatcherConfigSchema = z.object({
  tools: StringOrArraySchema.optional(),
  paths: StringOrArraySchema.optional(),
  commands: StringOrArraySchema.optional(),
});

const HookMatcherSchema = z.object({
  name: z.string().optional(),
  matcher: MatcherConfigSchema.optional(),
  hooks: z.array(HookSchema),
});

const _HookConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultTimeout: z.number().positive().optional(),
  timeoutBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  failureBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  maxConcurrentHooks: z.number().positive().optional(),
  // 工具执行类
  PreToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUseFailure: z.array(HookMatcherSchema).optional(),
  PermissionRequest: z.array(HookMatcherSchema).optional(),
  // 会话生命周期类
  UserPromptSubmit: z.array(HookMatcherSchema).optional(),
  SessionStart: z.array(HookMatcherSchema).optional(),
  SessionEnd: z.array(HookMatcherSchema).optional(),
  // 控制流类
  Stop: z.array(HookMatcherSchema).optional(),
  SubagentStop: z.array(HookMatcherSchema).optional(),
  // 其他
  Notification: z.array(HookMatcherSchema).optional(),
  Compaction: z.array(HookMatcherSchema).optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * 安全解析 Hook 输出 (不抛出异常)
 */
export function safeParseHookOutput(
  data: unknown
):
  | { success: true; data: z.infer<typeof HookOutputSchema> }
  | { success: false; error: z.ZodError } {
  const result = HookOutputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
