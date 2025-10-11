/**
 * Agent核心类型定义
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { ChatConfig, Message } from '../services/ChatService.js';

/**
 * 聊天上下文接口
 */
export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

/**
 * Agent 创建选项
 */
export interface AgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentConfig {
  chat: ChatConfig;
  systemPrompt?: string;
  context?: {
    enabled?: boolean;
    maxTokens?: number;
    maxMessages?: number;
    compressionEnabled?: boolean;
  };
  planning?: {
    enabled?: boolean;
    maxSteps?: number;
  };
  subagents?: {
    enabled?: boolean;
    maxConcurrent?: number;
  };
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

export interface LoopConfig {
  maxTurns?: number;
  autoCompact?: boolean;
  compressionThreshold?: number;
  loopDetection?: {
    enabled: boolean;
    toolCallThreshold: number;
    contentRepeatThreshold: number;
    llmCheckInterval: number;
  };
}

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
    type: 'canceled' | 'max_turns_exceeded' | 'api_error' | 'loop_detected' | 'aborted';
    message: string;
    details?: any;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
  };
}
