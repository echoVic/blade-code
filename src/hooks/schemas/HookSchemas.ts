/**
 * Hook System Zod Schemas
 *
 * 用于验证 Hook 输入输出的 Zod Schema
 */

import { z } from 'zod';
import {
  HookEvent,
  DecisionBehavior,
  PermissionDecision,
  HookType,
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

export const PreToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PreToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
});

export const PostToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.unknown()),
  tool_response: z.unknown(),
});

export const StopInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Stop),
  reason: z.string().optional(),
});

export const HookInputSchema = z.discriminatedUnion('hook_event_name', [
  PreToolUseInputSchema,
  PostToolUseInputSchema,
  StopInputSchema,
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

export const HookOutputSchema = z.object({
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

const HookSchema = z.discriminatedUnion('type', [
  CommandHookSchema,
  PromptHookSchema,
]);

const MatcherConfigSchema = z.object({
  tools: z.string().optional(),
  paths: z.string().optional(),
  commands: z.string().optional(),
});

const HookMatcherSchema = z.object({
  name: z.string().optional(),
  matcher: MatcherConfigSchema.optional(),
  hooks: z.array(HookSchema),
});

export const HookConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultTimeout: z.number().positive().optional(),
  timeoutBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  failureBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  maxConcurrentHooks: z.number().positive().optional(),
  PreToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUse: z.array(HookMatcherSchema).optional(),
  Stop: z.array(HookMatcherSchema).optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * 验证 Hook 输入
 */
export function validateHookInput(data: unknown): z.infer<typeof HookInputSchema> {
  return HookInputSchema.parse(data);
}

/**
 * 验证 Hook 输出
 */
export function validateHookOutput(data: unknown): z.infer<typeof HookOutputSchema> {
  return HookOutputSchema.parse(data);
}

/**
 * 验证 Hook 配置
 */
export function validateHookConfig(data: unknown): z.infer<typeof HookConfigSchema> {
  return HookConfigSchema.parse(data);
}

/**
 * 安全解析 Hook 输出 (不抛出异常)
 */
export function safeParseHookOutput(
  data: unknown
): { success: true; data: z.infer<typeof HookOutputSchema> } | { success: false; error: z.ZodError } {
  const result = HookOutputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
