/**
 * Agent核心类型定义
 */

import type { PermissionConfig } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { SessionTurnRecoveryAssessment } from '../context/turnRecoveryAssessment.js';
import type { MessagePersistenceMetadata } from '../context/types.js';
import type { GoalExecutionFrontierPreparation } from '../goals/executionFrontier.js';
import type {
  GoalCompletionVerificationResult,
  GoalSnapshot,
} from '../goals/types.js';
import type {
  ChatCompletionMessageToolCall,
  ContentPart,
  Message,
} from '../services/ChatServiceInterface.js';
import type { JsonObject } from '../store/types.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../tools/types/ToolTypes.js';
import type {
  PreparedInputTurn,
  SteeringMessage,
} from './runtime/ActiveTurnMailbox.js';
import type { TaskAdmissionHandle } from './runtime/TaskRunScheduler.js';
import type { SubagentConfig } from './subagents/types.js';

/**
 * 用户消息内容类型
 * 支持纯文本或多模态内容（文本 + 图片）
 */
export type UserMessageContent = string | ContentPart[];

/**
 * 子代理信息（用于 JSONL 写入）
 */
export interface SubagentInfoForContext {
  parentSessionId: string;
  providerAdmissionOwnerId?: string;
  subagentType: string;
  isSidechain: boolean;
  resumedFrom?: string;
  rootAgentId?: string;
  resumeDepth?: number;
}

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
  /** Shared task-list scope inherited by coordinated Agent Team members. */
  taskListId?: string;
  /** Task-list scope derived from the active persisted Goal. */
  goalTaskListId?: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler; // 会话级别的确认处理器
  permissionMode?: PermissionMode; // 当前权限模式（用于 Plan 模式判断）
  onPermissionModeChange?: (permissionMode: PermissionMode) => void | Promise<void>;
  systemPrompt?: string; // 动态传入的系统提示词（无状态设计）
  completionRequirements?: string; // 内部完成门禁要求，不写入对话历史
  worktreeActive?: boolean; // 当前会话已由父级放入 managed worktree
  subagentInfo?: SubagentInfoForContext; // 子代理信息（用于 JSONL 写入）
}

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export interface AgentOptions {
  sessionId?: string;
  // 运行时参数
  systemPrompt?: string; // 完全替换系统提示
  appendSystemPrompt?: string; // 追加系统提示
  permissions?: Partial<PermissionConfig>; // 运行时覆盖权限
  permissionMode?: PermissionMode;
  maxTurns?: number; // 最大对话轮次 (-1=无限制, 0=禁用对话, N>0=限制轮次)
  toolWhitelist?: string[]; // 工具白名单（仅允许指定工具）
  toolBlacklist?: string[]; // 工具黑名单（禁止指定工具）
  modelId?: string;
  agents?: SubagentConfig[];

  // MCP 配置
  mcpConfig?: string[]; // CLI 参数：MCP 配置文件路径或 JSON 字符串数组
  strictMcpConfig?: boolean; // CLI 参数：严格模式，仅使用 --mcp-config 指定的配置
}

export interface AgentTask {
  id: string;
  type: 'simple';
  prompt: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  taskId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ===== Agentic Loop Types =====

/**
 * Agentic Loop 选项
 *
 * 职责：控制循环行为
 * - 循环控制参数（maxTurns, autoCompact 等）
 * - 行为回调（onToolApprove, onToolResult, onTurnLimitReached）
 *
 * 设计原则：
 * - Phase 4 完成：事件通知回调已移除，消费者通过 chatStream() + LoopEvent 获取事件
 * - 保留的回调都是 behavioral（影响循环控制流），不是 notification
 * - 和 ChatContext 职责分离：LoopOptions = 行为控制，ChatContext = 数据状态
 */
export interface LoopOptions {
  // 循环控制参数
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  /** Start a turn from the runtime-owned durable inbox without a synthetic user message. */
  pendingInputOnly?: boolean;
  /** Runtime-prepared turn whose input was fsynced before the caller acknowledged it. */
  preparedInputTurn?: PreparedInputTurn;
  /** Durable inbox identity attached to the direct user transcript entry. */
  inputMessageId?: string;
  /** Metadata attached to the durable direct user transcript entry. */
  inputPersistenceMetadata?: MessagePersistenceMetadata;
  /** Original user input retained in memory for host policy evaluation. */
  policyUserMessage?: UserMessageContent;
  /** Start or resume work from the persisted goal instead of a user prompt. */
  goalContinuationOnly?: boolean;
  /** Model-visible control input that must not remain in transcript history. */
  transientInput?: 'goal_continuation';
  /** Turn-scoped JSON Schema for the canonical final response. */
  outputSchema?: JsonObject;
  /** Whether the host may require the built-in independent verification subagent. */
  builtinVerification?: boolean;
  /** Host-owned completion authority for an active persisted goal. */
  goalLifecycle?: {
    snapshot: GoalSnapshot | null;
    getSnapshot: () => Promise<GoalSnapshot | null>;
    recordVerification: (
      result: GoalCompletionVerificationResult
    ) => Promise<GoalSnapshot>;
    invalidateVerification: (reason: string) => Promise<GoalSnapshot>;
    finalizeCompletion: () => Promise<GoalSnapshot>;
    refreshFrontier?: () => Promise<GoalExecutionFrontierPreparation | null>;
  };
  /** Optional surface-reserved admission used for accurate queued responses. */
  taskAdmission?: TaskAdmissionHandle;
  /** SessionRuntime-owned same-turn user steering source. */
  turnSteering?: {
    drain: () => Promise<SteeringMessage[]>;
    drainOrSeal: () => Promise<{
      messages: SteeringMessage[];
      sealed: boolean;
    }>;
  };
  /** Runtime ownership needed to make a final assistant step recoverably terminal. */
  turnFinalization?: {
    turnId: string;
    getInputMessageIds: () => Promise<string[]>;
  };
  /** Runtime-owned state recovered from an interrupted turn for the same inbox input. */
  getRecoveredEmptyFinalState?: () => Promise<{
    hadSuccessfulToolResult: boolean;
    correctionSpent: boolean;
  }>;

  // 行为回调（影响循环控制流，不是事件通知）
  /** 工具审批门控 - 返回 false 阻止工具执行 */
  onToolApprove?: (toolCall: ChatCompletionMessageToolCall) => Promise<boolean>;
  /** 工具结果后处理 - 可修改/替换工具结果 */
  onToolResult?: (
    toolCall: ChatCompletionMessageToolCall,
    result: ToolResult
  ) => Promise<ToolResult | void>;
  /** 轮次限制决策 - 达到上限时询问是否继续 */
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
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
      | 'chat_disabled'
      | 'context_compaction_failed'
      | 'intent_fulfillment_failed'
      | 'delegation_protocol_failed'
      | 'verification_failed'
      | 'goal_verification_failed'
      | 'goal_frontier_unavailable'
      | 'worktree_protocol_failed'
      | 'structured_output_failed'
      | 'message_persistence_failed'
      | 'tool_persistence_failed';
    message: string;
    details?: unknown;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed?: number; // Token 使用量
    toolSuccessRate?: number; // 工具成功率 (0-1)
    totalToolFailures?: number; // 工具总失败次数
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
    shouldExitLoop?: boolean; // ExitPlanMode 或用户拒绝时设置此标记以退出循环
    targetMode?: PermissionMode; // Plan 模式批准后的目标权限模式
    planContent?: string; // Plan 模式批准后的方案内容
    outputTruncated?: boolean; // finishReason === 'length' 且 recovery 达上限时标记截断
    abortReason?: string; // abort 原因：'user-cancel' | 'interrupt'
    structuredOutput?: JsonObject;
    structuredOutputSchemaDigest?: string;
    goalCompletionVerified?: boolean;
    goalVerificationVerdict?: 'pass' | 'fail' | 'partial';
    goalVerifierSessionId?: string;
    goalVerificationEvidenceSha256?: string;
    recoveryAttention?: Extract<
      SessionTurnRecoveryAssessment,
      { state: 'requires_attention' }
    >;
  };
}
