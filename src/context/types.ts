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

/**
 * JSONL 消息类型（类似 Claude Code）
 */
export type JSONLMessageType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'file-history-snapshot';

/**
 * JSONL 条目 - Blade 会话历史格式
 */
export interface BladeJSONLEntry {
  /** 消息唯一 ID (nanoid) */
  uuid: string;
  /** 父消息 ID (用于对话线程追踪) */
  parentUuid: string | null;
  /** 逻辑父消息 ID (跨压缩边界的逻辑关联) */
  logicalParentUuid?: string;
  /** 会话 ID (nanoid) */
  sessionId: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 消息类型 */
  type: JSONLMessageType;
  /** 工作目录（绝对路径） */
  cwd: string;
  /** Git 分支信息（如果在 Git 仓库中） */
  gitBranch?: string;
  /** Blade 版本号 */
  version: string;
  /** 消息内容 */
  message: {
    role: 'user' | 'assistant' | 'system';
    content: string | any; // 可以是字符串或复杂内容块
    model?: string; // AI 模型名称（assistant 消息）
    usage?: {
      // Token 使用情况（assistant 消息）
      input_tokens: number;
      output_tokens: number;
    };
  };
  /** 工具调用信息（tool_use 类型） */
  tool?: {
    id: string;
    name: string;
    input: any;
  };
  /** 工具结果信息（tool_result 类型） */
  toolResult?: {
    id: string;
    output: any;
    error?: string;
  };

  // === 压缩相关字段（新增） ===
  /** 消息子类型（用于标记特殊消息，如压缩边界） */
  subtype?: 'compact_boundary';
  /** 是否为压缩总结消息 */
  isCompactSummary?: boolean;
  /** 压缩元数据 */
  compactMetadata?: {
    /** 触发方式：自动或手动 */
    trigger: 'auto' | 'manual';
    /** 压缩前的 token 数量 */
    preTokens: number;
    /** 压缩后的 token 数量 */
    postTokens?: number;
    /** 包含的文件列表 */
    filesIncluded?: string[];
  };
}
