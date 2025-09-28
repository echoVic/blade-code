/**
 * 上下文管理模块的核心类型定义
 */

export interface ContextMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
  output?: any;
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
  preferences: Record<string, any>;
  configuration: Record<string, any>;
  startTime: number;
}

export interface ConversationContext {
  messages: ContextMessage[];
  summary?: string;
  topics: string[];
  lastActivity: number;
}

export interface ToolContext {
  recentCalls: ToolCall[];
  toolStates: Record<string, any>;
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
  environment: Record<string, any>;
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