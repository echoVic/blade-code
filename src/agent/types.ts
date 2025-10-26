/**
 * Agent核心类型定义
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { PermissionConfig } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { Message } from '../services/OpenAIChatService.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../tools/types/ToolTypes.js';

/**
 * 聊天上下文接口
 *
 * 职责：保存会话相关的数据和状态
 * - 消息历史、会话标识、用户标识等数据
 * - 会话级别的 UI 交互处理器（如 confirmationHandler）
 *
 * 不包含：循环过程中的事件回调（这些应该放在 LoopOptions）
 */
export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler; // 会话级别的确认处理器
  permissionMode?: string; // 传递当前权限模式（用于 Plan 模式判断）
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

/**
 * Agentic Loop 选项
 *
 * 职责：控制循环行为和监听循环事件
 * - 循环控制参数（maxTurns, autoCompact 等）
 * - 循环过程中的事件回调（onTurnStart, onToolResult 等）
 *
 * 设计原则：
 * - 所有循环相关的回调统一放在这里，保持语义一致性
 * - 和 ChatContext 职责分离：LoopOptions = 行为控制，ChatContext = 数据状态
 */
export interface LoopOptions {
  // 循环控制参数
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  stream?: boolean;

  // 循环事件回调（监听循环过程）
  onTurnStart?: (data: { turn: number; maxTurns: number }) => void;
  onToolUse?: (
    toolCall: ChatCompletionMessageToolCall
  ) => Promise<ChatCompletionMessageToolCall | void>;
  onToolApprove?: (toolCall: ChatCompletionMessageToolCall) => Promise<boolean>;
  onToolResult?: (
    toolCall: ChatCompletionMessageToolCall,
    result: ToolResult
  ) => Promise<ToolResult | void>;
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
    shouldExitLoop?: boolean; // ExitPlanMode 设置此标记以退出循环
    targetMode?: string; // Plan 模式批准后的目标权限模式（default/auto_edit）
  };
}
