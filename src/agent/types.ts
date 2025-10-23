/**
 * Agent核心类型定义
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { PermissionConfig } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { Message } from '../services/OpenAIChatService.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';

/**
 * 聊天上下文接口
 */
export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
}

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 ConfigManager.getConfig() (BladeConfig)
 */
export interface AgentOptions {
  // 运行时参数
  systemPrompt?: string; // 完全替换系统提示
  appendSystemPrompt?: string; // 追加系统提示
  permissions?: Partial<PermissionConfig>; // 运行时覆盖权限
  permissionMode?: PermissionMode;
  maxTurns?: number; // 最大对话轮次 (-1=无限制, 0=禁用对话, N>0=限制轮次)
}

export interface AgentTask {
  id: string;
  type: 'simple' | 'complex' | 'recursive' | 'parallel' | 'steering';
  prompt: string;
  context?: Record<string, unknown>;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  taskId: string;
  content: string;
  subAgentResults?: SubAgentResult[];
  executionPlan?: ExecutionStep[];
  metadata?: Record<string, unknown>;
}

export interface SubAgentResult {
  agentName: string;
  taskType: string;
  result: unknown;
  executionTime: number;
}

export interface ExecutionStep {
  id: string;
  type: 'llm' | 'tool' | 'subagent';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SubAgentInfo {
  name: string;
  description: string;
  capabilities: string[];
  specialization: string;
  maxConcurrentTasks: number;
  priority: number;
}

export interface ContextData {
  messages: Message[];
  metadata?: Record<string, unknown>;
}

export interface ContextConfig {
  maxTokens?: number;
  maxMessages?: number;
  compressionEnabled?: boolean;
  storagePath?: string;
}

// ===== Agentic Loop Types =====

export interface LoopOptions {
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  onTurnStart?: (data: { turn: number; maxTurns: number }) => void;
  onToolUse?: (
    toolCall: ChatCompletionMessageToolCall
  ) => Promise<ChatCompletionMessageToolCall | void>;
  onToolApprove?: (toolCall: ChatCompletionMessageToolCall) => Promise<boolean>;
  onToolResult?: (
    toolCall: ChatCompletionMessageToolCall,
    result: any
  ) => Promise<any | void>;
}

export interface LoopResult {
  success: boolean;
  finalMessage?: string;
  error?: {
    type:
      | 'canceled'
      | 'max_turns_exceeded'
      | 'api_error'
      | 'loop_detected'
      | 'aborted'
      | 'chat_disabled';
    message: string;
    details?: any;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
  };
}
