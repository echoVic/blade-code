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

export interface SessionTaskDiffStat {
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
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
  taskStartedAt?: string | null;
  taskCompletedAt?: string | null;
  taskOwnerPid?: number | null;
  taskPromptSummary?: string | null;
  taskIsolation?: SessionTaskIsolation | null;
  taskSourceProjectPath?: string | null;
  taskWorktree?: SessionTaskWorktree | null;
  taskDiffStat?: SessionTaskDiffStat | null;
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
  | (SessionEventBase & { type: 'session_rewound'; data: SessionRewindInfo })
  | (SessionEventBase & {
      type: 'inbox_acknowledged';
      data: InboxAcknowledgementInfo;
    })
  | (SessionEventBase & { type: 'message_created'; data: MessageInfo })
  | (SessionEventBase & { type: 'part_created'; data: PartInfo })
  | (SessionEventBase & { type: 'part_updated'; data: PartInfo });
