/**
 * 上下文管理模块的核心类型定义
 */

import type { JsonObject, JsonValue, MessageRole } from '../store/types.js';

export interface ContextMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  timestamp: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

export interface SystemContext {
  role: string;
  capabilities: string[];
  tools: string[];
  version: string;
}

export interface SessionContext {
  sessionId: string;
  userId?: string;
  preferences: JsonObject;
  configuration: JsonObject;
  startTime: number;
}

export interface ConversationContext {
  messages: ContextMessage[];
  summary?: string;
  topics: string[];
  lastActivity: number;
}

interface ToolContext {
  recentCalls: ToolCall[];
  toolStates: JsonObject;
  dependencies: Record<string, string[]>;
}

export interface WorkspaceContext {
  projectPath?: string;
  currentFiles: string[];
  recentFiles: string[];
  gitInfo?: {
    branch: string;
    status: string;
    lastCommit?: string;
  };
  environment: JsonObject;
}

export interface ContextLayer {
  system: SystemContext;
  session: SessionContext;
  conversation: ConversationContext;
  tool: ToolContext;
  workspace: WorkspaceContext;
}

export interface ContextData {
  layers: ContextLayer;
  metadata: {
    totalTokens: number;
    priority: number;
    relevanceScore?: number;
    lastUpdated: number;
  };
}

export interface ContextFilter {
  maxTokens?: number;
  maxMessages?: number;
  timeWindow?: number; // 毫秒
  priority?: number;
  includeTools?: boolean;
  includeWorkspace?: boolean;
}

export interface CompressedContext {
  summary: string;
  keyPoints: string[];
  recentMessages: ContextMessage[];
  toolSummary?: string;
  tokenCount: number;
}

export interface ContextStorageOptions {
  maxMemorySize: number;
  persistentPath?: string;
  cacheSize: number;
  compressionEnabled: boolean;
}

export interface ContextManagerOptions {
  storage: ContextStorageOptions;
  defaultFilter: ContextFilter;
  compressionThreshold: number;
  enableVectorSearch?: boolean;
}

/**
 * JSONL 消息类型
 */
export type JSONLEventType =
  | 'session_created'
  | 'session_updated'
  | 'message_created'
  | 'part_created'
  | 'part_updated';

export type PartType =
  | 'text'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref';

export interface SessionInfo {
  sessionId: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent';
  title?: string;
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  permission?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface MessageInfo {
  messageId: string;
  role: MessageRole;
  parentMessageId?: string;
  createdAt: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface PartInfo {
  partId: string;
  messageId: string;
  partType: PartType;
  payload: JsonValue;
  createdAt: string;
}

export interface SessionEventBase {
  id: string;
  sessionId: string;
  timestamp: string;
  type: JSONLEventType;
  cwd: string;
  gitBranch?: string;
  version: string;
}

export type SessionEvent =
  | (SessionEventBase & { type: 'session_created'; data: SessionInfo })
  | (SessionEventBase & { type: 'session_updated'; data: Partial<SessionInfo> })
  | (SessionEventBase & { type: 'message_created'; data: MessageInfo })
  | (SessionEventBase & { type: 'part_created'; data: PartInfo })
  | (SessionEventBase & { type: 'part_updated'; data: PartInfo });
