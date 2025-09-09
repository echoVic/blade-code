/**
 * Agent核心类型定义
 */

import type { ChatConfig, Message } from '../services/ChatService.js';

export interface AgentConfig {
  chat: ChatConfig;
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
