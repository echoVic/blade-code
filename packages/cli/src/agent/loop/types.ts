/**
 * AsyncGenerator Loop 类型定义
 *
 * 用于将 Agent.executeLoop() 重构为 AsyncGenerator 模式
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { BladeConfig } from '../../config/index.js';
import type { GoalSnapshot } from '../../goals/types.js';
import type { IChatService } from '../../services/ChatServiceInterface.js';
import type { TaskListItem } from '../../tools/builtin/task/taskListTypes.js';
import type { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { ExecutionEngine } from '../ExecutionEngine.js';
import type { SteeringMessage } from '../runtime/ActiveTurnMailbox.js';
import type { AgentOptions } from '../types.js';

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
  | { kind: 'model_fallback' };

/** 工具生命周期事件 */
export type ToolEvent =
  | { kind: 'tool_start'; toolCall: ToolCallRef; toolKind?: ToolKindStr }
  | { kind: 'tool_result'; toolCall: ToolCallRef; result: ToolResult };

/** 循环控制事件 */
export type SystemEvent =
  | { kind: 'turn_start'; turn: number; maxTurns: number }
  | { kind: 'compaction'; phase: 'start' | 'end' }
  | { kind: 'token_usage'; usage: TokenUsageInfo };

/** 业务事件 */
export type DomainEvent =
  | { kind: 'task_update'; tasks: TaskListItem[] }
  | {
      kind: 'steering_applied';
      messageIds: string[];
      count: number;
      recovered: number;
      delivery: 'current_turn' | 'next_turn';
    }
  | {
      kind: 'follow_up_started';
      queued: number;
      recovered: number;
      messages: Array<SteeringMessage & { persisted: boolean }>;
    }
  | { kind: 'goal_updated'; goal: GoalSnapshot | null }
  | {
      kind: 'goal_continuation_started';
      goal: GoalSnapshot;
      continuation: number;
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
      success: boolean;
      summary?: string;
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
}

// ===== Tool Execution Result (for StreamingToolExecutor) =====

export interface ToolExecResult {
  toolCall: ToolCallRef;
  result: ToolResult;
  toolUseUuid: string | null;
  error?: Error;
}
