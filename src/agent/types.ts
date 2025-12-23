/**
 * Agent核心类型定义
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { PermissionConfig } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { ContentPart, Message } from '../services/ChatServiceInterface.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../tools/types/ToolTypes.js';

/**
 * 用户消息内容类型
 * 支持纯文本或多模态内容（文本 + 图片）
 */
export type UserMessageContent = string | ContentPart[];

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
  permissionMode?: PermissionMode; // 当前权限模式（用于 Plan 模式判断）
}

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export interface AgentOptions {
  // 运行时参数
  systemPrompt?: string; // 完全替换系统提示
  appendSystemPrompt?: string; // 追加系统提示
  permissions?: Partial<PermissionConfig>; // 运行时覆盖权限
  permissionMode?: PermissionMode;
  maxTurns?: number; // 最大对话轮次 (-1=无限制, 0=禁用对话, N>0=限制轮次)
  toolWhitelist?: string[]; // 工具白名单（仅允许指定工具）

  // MCP 配置
  mcpConfig?: string[]; // CLI 参数：MCP 配置文件路径或 JSON 字符串数组
  strictMcpConfig?: boolean; // CLI 参数：严格模式，仅使用 --mcp-config 指定的配置
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
  onToolApprove?: (toolCall: ChatCompletionMessageToolCall) => Promise<boolean>;
  onToolResult?: (
    toolCall: ChatCompletionMessageToolCall,
    result: ToolResult
  ) => Promise<ToolResult | void>;

  // 🆕 流式信息显示回调
  onContentDelta?: (delta: string) => void; // 流式文本片段
  onContent?: (content: string) => void; // 完整的 LLM 输出内容
  onThinking?: (content: string) => void; // LLM 推理过程(深度推理模型)
  onToolStart?: (
    toolCall: ChatCompletionMessageToolCall,
    toolKind?: 'readonly' | 'write' | 'execute'
  ) => void; // 工具调用开始，toolKind 表示工具类型

  // Token 使用量回调
  onTokenUsage?: (usage: {
    inputTokens: number; // 当前轮 prompt tokens
    outputTokens: number; // 当前轮 completion tokens
    totalTokens: number; // 累计总 tokens
    maxContextTokens: number; // 上下文窗口大小
  }) => void;

  // 压缩状态回调
  onCompacting?: (isCompacting: boolean) => void;

  // 轮次限制回调（100 轮后询问用户是否继续）
  onTurnLimitReached?: (data: {
    turnsCount: number;
  }) => Promise<TurnLimitResponse>;
}

/**
 * 轮次限制响应
 */
export interface TurnLimitResponse {
  continue: boolean;
  reason?: string;
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
    tokensUsed?: number; // Token 使用量
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
    shouldExitLoop?: boolean; // ExitPlanMode 或用户拒绝时设置此标记以退出循环
    targetMode?: PermissionMode; // Plan 模式批准后的目标权限模式
    planContent?: string; // Plan 模式批准后的方案内容
  };
}
