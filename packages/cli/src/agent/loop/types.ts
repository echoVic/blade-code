/**
 * AsyncGenerator Loop 类型定义
 *
 * 用于将 Agent.executeLoop() 重构为 AsyncGenerator 模式
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { BladeConfig } from '../../config/index.js';
import type { IChatService } from '../../services/ChatServiceInterface.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { ExecutionEngine } from '../ExecutionEngine.js';
import type { AgentOptions } from '../types.js';

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
}

// ===== Loop Events =====

/** Generator yield 的事件联合类型 */
export type LoopEvent =
  | { type: 'turn_start'; turn: number; maxTurns: number }
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'stream_end' }
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; toolCall: ToolCallRef; toolKind?: ToolKindStr }
  | { type: 'tool_result'; toolCall: ToolCallRef; result: ToolResult }
  | { type: 'compaction_start' }
  | { type: 'compaction_end' }
  | { type: 'token_usage'; usage: TokenUsageInfo }
  | { type: 'todo_update'; todos: TodoItem[] };

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
  executionPipeline: ExecutionPipeline;
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
  applySkillToolRestrictions: (
    tools: FunctionDeclaration[]
  ) => FunctionDeclaration[];
}

// ===== Tool Execution Result (for StreamingToolExecutor) =====

export interface ToolExecResult {
  toolCall: ToolCallRef;
  result: ToolResult;
  toolUseUuid: string | null;
  error?: Error;
}
