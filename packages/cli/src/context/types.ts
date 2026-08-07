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
  projectPath: string;
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
  | 'session_rewound'
  | 'inbox_acknowledged'
  | 'message_created'
  | 'part_created'
  | 'part_updated';

export type PartType =
  | 'text'
  | 'reasoning'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref';

export type SessionTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type SessionTaskIsolation = 'local' | 'worktree';

export type SessionTaskFailureCode =
  | 'authentication'
  | 'permission'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'model_unavailable'
  | 'context_limit'
  | 'unsupported_input'
  | 'runtime';

export interface SessionTaskFailure {
  code: SessionTaskFailureCode;
  message: string;
  retryable: boolean;
}

export interface SessionTaskDiffStat {
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
}

export type SessionTaskPermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';

export interface SessionTaskAttachment {
  type: 'file' | 'image' | 'url';
  path?: string;
  url?: string;
  content?: string;
  mimeType?: string;
  name?: string;
}

export interface SessionTaskDispatch {
  version: 1;
  prompt: string;
  title?: string;
  sourceProjectPath: string;
  isolation: SessionTaskIsolation;
  permissionMode: SessionTaskPermissionMode;
  modelId?: string;
  attachments?: SessionTaskAttachment[];
}

export interface SessionTaskRetryRef {
  sessionId: string;
  projectPath: string;
}

export type SessionTaskDeliveryStatus = 'applied' | 'discarded' | 'conflicted';

export interface SessionTaskDelivery {
  status: SessionTaskDeliveryStatus;
  updatedAt: string;
  sourceCommit?: string;
  changedFiles?: number;
  message?: string;
}

export interface SessionTaskWorktree {
  sessionId: string;
  name: string;
  branch: string;
  baseCommit: string;
  originalBranch: string;
  repositoryRoot: string;
  originalWorkspaceRoot: string;
  worktreeRoot: string;
  workspaceRoot: string;
  sourceHadChanges: boolean;
  sourceStateFingerprint?: string;
}

export interface SessionInfo {
  sessionId: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  resumedFrom?: string;
  rootAgentId?: string;
  resumeDepth?: number;
  title?: string;
  status?: 'running' | 'completed' | 'failed';
  taskStatus?: SessionTaskStatus;
  taskStatusReason?: string | null;
  taskFailure?: SessionTaskFailure | null;
  taskStartedAt?: string | null;
  taskCompletedAt?: string | null;
  taskOwnerPid?: number | null;
  taskPromptSummary?: string | null;
  taskDispatch?: SessionTaskDispatch | null;
  taskModelId?: string | null;
  taskRetriedFrom?: SessionTaskRetryRef | null;
  taskDelivery?: SessionTaskDelivery | null;
  taskIsolation?: SessionTaskIsolation | null;
  taskSourceProjectPath?: string | null;
  taskWorktree?: SessionTaskWorktree | null;
  taskDiffStat?: SessionTaskDiffStat | null;
  taskQueuePosition?: number | null;
  taskQueueDepth?: number | null;
  taskConcurrencyLimit?: number | null;
  selectedModelId?: string | null;
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
  inboxMessageId?: string;
  createdAt: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface InboxAcknowledgementInfo {
  messageIds: string[];
  acknowledgedAt: string;
}

export type SessionRewindMode = 'conversation' | 'code' | 'both';

export interface SessionRewindInfo {
  rewindId: string;
  targetMessageId: string;
  mode: SessionRewindMode;
  restoredFiles: string[];
  createdAt: string;
}

export interface SubagentRunRef {
  subagentSessionId: string;
  subagentType: string;
  subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  subagentSummary?: string;
  subagentResumedFrom?: string;
  subagentRootId?: string;
  subagentResumeDepth?: number;
}

export interface PartInfo {
  partId: string;
  messageId: string;
  partType: PartType;
  payload: JsonValue;
  createdAt: string;
}

export interface SessionEventBase {
  /**
   * 单调递增的序列号，每个 session 独立。由 SessionEventLog 在 commit 时分配。
   * 旧 transcript 缺失该字段时，读取路径按行号（1-based）回填，保证 replay/续传可用。
   */
  seq?: number;
  id: string;
  sessionId: string;
  /** 事件所属项目路径。新事件写入，旧 transcript 可缺省。 */
  projectPath?: string;
  timestamp: string;
  type: JSONLEventType;
  cwd: string;
  gitBranch?: string;
  version: string;
}

export type SessionEvent =
  | (SessionEventBase & { type: 'session_created'; data: SessionInfo })
  | (SessionEventBase & { type: 'session_updated'; data: Partial<SessionInfo> })
  | (SessionEventBase & { type: 'session_rewound'; data: SessionRewindInfo })
  | (SessionEventBase & {
      type: 'inbox_acknowledged';
      data: InboxAcknowledgementInfo;
    })
  | (SessionEventBase & { type: 'message_created'; data: MessageInfo })
  | (SessionEventBase & { type: 'part_created'; data: PartInfo })
  | (SessionEventBase & { type: 'part_updated'; data: PartInfo });
