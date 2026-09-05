/**
 * AsyncGenerator Loop 类型定义
 *
 * 用于将 Agent.executeLoop() 重构为 AsyncGenerator 模式
 */

import type { FollowUpQueueSnapshot } from '../../api/followUpQueueSchemas.js';
import type { ProviderRecoveryProjection } from '../../api/providerRecoverySchemas.js';
import type { TurnActivityProjection } from '../../api/turnActivitySchemas.js';
import type { BladeConfig } from '../../config/index.js';
import type { ContextTokenSource } from '../../context/ContextTokenTracker.js';
import type {
  CompactionFailureReason,
  CompactionOutcome,
  CompactionReason,
  CompactionStrategy,
} from '../../context/compactionCheckpoint.js';
import type { SessionTurnRecoveryAssessment } from '../../context/turnRecoveryAssessment.js';
import type {
  GoalExecutionFrontier,
  GoalPrematureStopPattern,
  GoalSnapshot,
} from '../../goals/types.js';
import type { MemoryConsolidationProjection } from '../../memory/MemoryConsolidation.js';
import type {
  ChatCompletionMessageToolCall,
  IChatService,
  PromptCacheBreakInfo,
} from '../../services/ChatServiceInterface.js';
import type { ProviderCircuitEvent } from '../../services/pi/providerCircuitBreaker.js';
import type { ProviderFallbackEvent } from '../../services/pi/providerFallback.js';
import type { ProviderAdmissionEvent } from '../../services/pi/providerRequestAdmission.js';
import type { ProviderRetryEvent } from '../../services/pi/providerRetry.js';
import type { ProviderStallEvent } from '../../services/pi/providerStall.js';
import type { JsonObject } from '../../store/types.js';
import type { TaskListItem } from '../../tools/builtin/task/taskListTypes.js';
import type { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import type { ToolProgressUpdate } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { ExecutionEngine } from '../ExecutionEngine.js';
import type {
  ProjectRuleReference,
  ProjectRuleResolution,
} from '../resources/WorkspaceProjectRules.js';
import type { SteeringMessage } from '../runtime/ActiveTurnMailbox.js';
import type { AgentOptions } from '../types.js';
import type { ActionStationarityEvent } from './actionStationarity.js';

// ===== Loop Event Subtypes =====

/** 流式增量事件 */
export type StreamEvent =
  | { kind: 'content_delta'; delta: string }
  | { kind: 'thinking_delta'; delta: string }
  /**
   * 单次 LLM turn 的流式输出结束信号。
   *
   * 在一次 agentic run 中，如果有多轮 LLM 调用（tool-use loop），
   * `stream_end` 会在每轮 LLM 输出结束时被 yield 一次，
   * 因此它可能出现多次。消费者应将其视为 per-turn 终止信号，
   * 而非整个 run 的完成标志。
   */
  | { kind: 'stream_end' }
  | ({ kind: 'model_fallback' } & ProviderFallbackEvent);

/** 工具生命周期事件 */
export type ToolEvent =
  | { kind: 'tool_start'; toolCall: ToolCallRef; toolKind?: ToolKindStr }
  | {
      kind: 'tool_progress';
      toolCall: ToolCallRef;
      update: ToolProgressUpdate;
    }
  | { kind: 'tool_result'; toolCall: ToolCallRef; result: ToolResult };

/** 循环控制事件 */
export type SystemEvent =
  | { kind: 'turn_start'; turn: number; maxTurns: number }
  | {
      kind: 'compaction';
      phase: 'start' | 'end';
      reason?: CompactionReason;
      strategy?: CompactionStrategy;
      outcome?: CompactionOutcome;
      preTokens?: number;
      preTokenSource?: ContextTokenSource;
      estimatedPendingTokens?: number;
      postTokens?: number;
      sampleAttempts?: number;
      inputReductions?: number;
      messagesOmitted?: number;
      filesOmitted?: number;
      imagesOmitted?: number;
      fallbackTargetTokens?: number;
      fallbackMessagesOmitted?: number;
      fallbackMessagesTruncated?: number;
      failureReason?: CompactionFailureReason;
      memory?: MemoryConsolidationProjection;
    }
  | { kind: 'token_usage'; usage: TokenUsageInfo }
  | ({ kind: 'provider_admission' } & ProviderAdmissionEvent)
  | ({ kind: 'provider_circuit' } & ProviderCircuitEvent)
  | ({ kind: 'provider_retry' } & ProviderRetryEvent)
  | ({ kind: 'provider_stall' } & ProviderStallEvent)
  | { kind: 'provider_recovery'; recovery: ProviderRecoveryProjection }
  | { kind: 'turn_activity'; activity: TurnActivityProjection }
  | ({ kind: 'action_stationarity' } & ActionStationarityEvent);

/** 业务事件 */
export type DomainEvent =
  | {
      kind: 'turn_recovery';
      assessment: Exclude<SessionTurnRecoveryAssessment, { state: 'none' }>;
    }
  | { kind: 'task_update'; tasks: TaskListItem[] }
  | {
      kind: 'goal_frontier_updated';
      goal: GoalSnapshot;
      frontier: GoalExecutionFrontier;
      tasks: TaskListItem[];
    }
  | {
      kind: 'structured_output';
      output: JsonObject;
      schemaDigest: string;
    }
  | {
      kind: 'steering_applied';
      messageIds: string[];
      count: number;
      recovered: number;
      delivery: 'current_turn' | 'next_turn';
      messages: SteeringMessage[];
      queue: FollowUpQueueSnapshot;
    }
  | {
      kind: 'follow_up_started';
      queued: number;
      recovered: number;
      messages: Array<SteeringMessage & { persisted: boolean }>;
      queue: FollowUpQueueSnapshot;
    }
  | { kind: 'follow_up_queue_changed'; queue: FollowUpQueueSnapshot }
  | { kind: 'goal_updated'; goal: GoalSnapshot | null }
  | {
      kind: 'mcp_catalog_changed';
      revision: number;
      serverName: string;
      reason: string;
      added: string[];
      removed: string[];
      updated: string[];
    }
  | {
      kind: 'mcp_content_changed';
      revision: number;
      serverName: string;
      contentKind: 'resources' | 'resourceTemplates' | 'prompts';
      reason: string;
      added: string[];
      removed: string[];
      updated: string[];
    }
  | {
      kind: 'mcp_resource_updated';
      revision: number;
      serverName: string;
      uri: string;
    }
  | {
      kind: 'mcp_connection_changed';
      revision: number;
      serverName: string;
      phase: 'reconnecting' | 'recovered' | 'failed';
      reason: string;
      attempt: number;
      maxAttempts: number;
      nextRetryAt?: number;
      error?: string;
    }
  | {
      kind: 'mcp_log';
      revision: number;
      serverName: string;
      level:
        | 'debug'
        | 'info'
        | 'notice'
        | 'warning'
        | 'error'
        | 'critical'
        | 'alert'
        | 'emergency';
      logger?: string;
      message: string;
      projectedBytes: number;
      dataSha256: string;
      truncated: boolean;
      detailsOmitted: boolean;
      timestamp: number;
      synthetic?: boolean;
    }
  | {
      kind: 'mcp_instructions_changed';
      revision: number;
      serverName: string;
      action: 'added' | 'removed';
      reason: 'snapshot' | 'connection' | 'disconnection';
      text?: string;
      sourceBytes?: number;
      projectedBytes?: number;
      sha256?: string;
      truncated?: boolean;
      detailsOmitted?: boolean;
    }
  | {
      kind: 'mcp_task_changed';
      revision: number;
      taskId: string;
      serverName: string;
      toolName: string;
      status:
        | 'working'
        | 'input_required'
        | 'interrupted'
        | 'completed'
        | 'failed'
        | 'cancelled';
      statusMessage?: string;
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
      hasResult: boolean;
      error?: string;
    }
  | {
      kind: 'project_rules_loaded';
      files: Array<{
        id: string;
        relativePath: string;
        source: 'project' | 'local';
        conditional: boolean;
        contentSha256: string;
      }>;
      triggerPaths: string[];
      blockedWrite: boolean;
    }
  | {
      kind: 'goal_continuation_started';
      goal: GoalSnapshot;
      continuation: number;
      prematureStopPattern?: GoalPrematureStopPattern;
      prematureStopCount?: number;
    }
  | {
      kind: 'subagent_spawned';
      sessionId: string;
      type: string;
      prompt: string;
      resumedFrom?: string;
      rootAgentId?: string;
      resumeDepth?: number;
    }
  | {
      kind: 'subagent_completed';
      sessionId: string;
      type: string;
      success: boolean;
      summary?: string;
      verificationVerdict?: 'pass' | 'fail' | 'partial';
      resumedFrom?: string;
      rootAgentId?: string;
      resumeDepth?: number;
    };

// ===== Tool Call Reference =====

/** 工具调用引用（与 OpenAI 格式兼容） */
export type ToolCallRef = ChatCompletionMessageToolCall;

export type ToolKindStr = 'readonly' | 'write' | 'execute';

// ===== Token Usage =====

export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheBreak?: PromptCacheBreakInfo;
  costUsd?: number;
}

// ===== Loop Events =====

/** Generator yield 的事件联合类型 */
export type LoopEvent = StreamEvent | ToolEvent | SystemEvent | DomainEvent;

// ===== Loop State =====

export type LoopPhase =
  | 'idle'
  | 'streaming'
  | 'executing_tools'
  | 'compacting'
  | 'complete'
  | 'error';

/** 循环状态（用于调试/可观测性） */
export interface LoopState {
  phase: LoopPhase;
  turn: number;
  totalTokens: number;
  toolCallsCount: number;
  transition?: {
    from: string;
    to: string;
    reason: string;
  };
}

// ===== Skill Execution Context =====

export interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

// ===== Function Declaration (re-export from tools) =====

import type { FunctionDeclaration as _FunctionDeclaration } from '../../tools/types/ToolTypes.js';

export type { FunctionDeclaration } from '../../tools/types/ToolTypes.js';

type FunctionDeclaration = _FunctionDeclaration;

// ===== Loop Dependencies =====

/** Generator 需要的所有外部依赖（从 Agent 实例注入） */
export interface LoopDependencies {
  chatService: IChatService;
  toolExecutor: ToolExecutor;
  executionEngine: ExecutionEngine | undefined;
  config: BladeConfig;
  runtimeOptions: AgentOptions;
  currentModelMaxContextTokens: number;
  activeSkillContext?: SkillExecutionContext;
  /** Skill 激活回调 */
  onSkillActivated?: (ctx: SkillExecutionContext) => void;
  /** 模型切换回调 */
  onModelSwitch?: (modelId: string) => Promise<void>;
  /** 应用 Skill 工具限制 */
  applySkillToolRestrictions: (tools: FunctionDeclaration[]) => FunctionDeclaration[];
  staticProjectRules?: ProjectRuleResolution;
  hydrateProjectRules?: (
    references: readonly ProjectRuleReference[]
  ) => ProjectRuleResolution;
  resolveContextualProjectRules?: (
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult | undefined,
    loadedIds: ReadonlySet<string>
  ) => ProjectRuleResolution;
}

// ===== Tool Execution Result (for StreamingToolExecutor) =====

export interface ToolExecResult {
  toolCall: ToolCallRef;
  result: ToolResult;
  toolUseUuid: string | null;
  error?: Error;
}
