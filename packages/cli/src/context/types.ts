/**
 * 上下文管理模块的核心类型定义
 */

import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../config/types.js';
import type { JsonObject, JsonValue, MessageRole } from '../store/types.js';

export const MAX_TURN_INPUT_MESSAGE_IDS = 120;
export const MAX_TURN_INPUT_MESSAGE_ID_CHARS = 128;

export function parseTurnInputMessageIds(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_TURN_INPUT_MESSAGE_IDS ||
    !value.every(
      (messageId) =>
        typeof messageId === 'string' &&
        messageId.length > 0 &&
        messageId.length <= MAX_TURN_INPUT_MESSAGE_ID_CHARS
    )
  ) {
    return undefined;
  }
  return [...new Set(value)];
}

export function parseTurnAbortAcknowledgedInputMessageIds(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!('recovery' in data) || !data.recovery) return [];
  const recovery = data.recovery;
  if (typeof recovery !== 'object' || Array.isArray(recovery)) return [];
  if (
    !('version' in recovery) ||
    (recovery.version !== 1 && recovery.version !== 2) ||
    !('inputMessageIds' in recovery) ||
    !('hadSuccessfulToolResult' in recovery) ||
    typeof recovery.hadSuccessfulToolResult !== 'boolean' ||
    !('emptyFinalCorrectionSpent' in recovery) ||
    typeof recovery.emptyFinalCorrectionSpent !== 'boolean' ||
    !('acknowledgedInputMessageIds' in data)
  ) {
    return [];
  }
  if (
    recovery.version === 2 &&
    (!('interruptedToolCallCount' in recovery) ||
      !Number.isSafeInteger(recovery.interruptedToolCallCount) ||
      (recovery.interruptedToolCallCount as number) < 0)
  ) {
    return [];
  }
  const recoveryInputMessageIds = parseTurnInputMessageIds(recovery.inputMessageIds);
  const acknowledgedInputMessageIds = parseTurnInputMessageIds(
    data.acknowledgedInputMessageIds
  );
  if (!recoveryInputMessageIds || !acknowledgedInputMessageIds) return [];
  const recoveryInputIds = new Set(recoveryInputMessageIds);
  return acknowledgedInputMessageIds.filter((messageId) =>
    recoveryInputIds.has(messageId)
  );
}

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
  | 'turn_started'
  | 'turn_completed'
  | 'turn_aborted'
  | 'turn_recovery_acknowledged'
  | 'inbox_acknowledged'
  | 'interaction_requested'
  | 'interaction_responded'
  | 'interaction_recovered'
  | 'review_started'
  | 'review_completed'
  | 'token_budget_handoff_recorded'
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
  | 'workspace_unavailable'
  | 'capacity'
  | 'runtime';

export type SessionTaskCapacityResource =
  | 'pending_count'
  | 'pending_bytes'
  | 'resident_runtimes';

export interface SessionTaskFailure {
  code: SessionTaskFailureCode;
  message: string;
  retryable: boolean;
  resource?: SessionTaskCapacityResource;
}

export interface SessionTaskDiffStat {
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
}

export type SessionPermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';
export type SessionTaskPermissionMode = SessionPermissionMode;

export type SessionInteractionType = 'permission' | 'question' | 'elicitation';

export interface SessionPendingInteraction {
  type: SessionInteractionType;
  requestId: string;
}

export interface SessionInteractionRequestInfo {
  requestId: string;
  toolCallId: string;
  toolName: string;
  interactionType: SessionInteractionType;
  details: JsonValue;
  requestedAt: string;
}

export interface SessionInteractionResponseInfo {
  requestId: string;
  response: JsonValue;
  respondedAt: string;
}

export interface SessionInteractionRecoveryInfo {
  requestId: string;
  inboxMessageId: string;
  recoveredAt: string;
}

export type SessionReviewTargetKind = 'uncommitted' | 'base' | 'commit';

export interface SessionReviewTargetInfo {
  kind: SessionReviewTargetKind;
  label: string;
  headSha: string;
  baseSha?: string;
  commitSha?: string;
  digest: string;
  fileCount: number;
}

export interface SessionReviewStartInfo {
  reviewId: string;
  reviewerSessionId: string;
  target: SessionReviewTargetInfo;
  startedAt: string;
}

export interface SessionReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidenceScore: number;
  codeLocation: {
    path: string;
    lineStart: number;
    lineEnd: number;
  };
}

export type SessionReviewStatus =
  | 'completed'
  | 'stale'
  | 'failed'
  | 'aborted'
  | 'interrupted';

export interface SessionReviewCompletionInfo {
  reviewId: string;
  status: SessionReviewStatus;
  overallExplanation: string;
  findings: SessionReviewFinding[];
  completedAt: string;
  error?: string;
}

export interface SessionTaskAttachment {
  type: 'file' | 'image' | 'url';
  path?: string;
  url?: string;
  content?: string;
  mimeType?: string;
  name?: string;
}

export type SessionTaskPriority = 'high' | 'medium' | 'low';
export type SessionTaskKind = 'feature' | 'bug' | 'maintenance' | 'research';

export interface SessionTaskDispatch {
  version: 1;
  prompt: string;
  title?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
  sourceProjectPath: string;
  isolation: SessionTaskIsolation;
  permissionMode: SessionTaskPermissionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  attachments?: SessionTaskAttachment[];
  outputSchema?: JsonObject;
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
  taskPriority?: SessionTaskPriority | null;
  taskKind?: SessionTaskKind | null;
  taskDueAt?: string | null;
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
  permissionMode?: SessionPermissionMode | null;
  reasoningEffort?: ReasoningEffortSelection | null;
  serviceTier?: ServiceTierSelection | null;
  responseVerbosity?: ResponseVerbositySelection | null;
  communicationStyle?: CommunicationStyleSelection | null;
  communicationStyleDigest?: string | null;
  projectInstructionsDigest?: string | null;
  pendingInteraction?: SessionPendingInteraction | null;
  archivedAt?: string | null;
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
  metadata?: JsonValue;
}

export interface MessagePersistenceMetadata {
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  inboxMessageId?: string;
  clientVisible?: boolean;
  emptyFinalCorrection?: boolean;
  contextualProjectRules?: boolean;
  ruleReferences?: JsonValue;
  triggerPaths?: string[];
  userPromptArtifact?: JsonValue;
  userShellCommand?: JsonValue;
  backgroundSubagentCompletion?: JsonValue;
  teamMessage?: JsonValue;
  codeReview?: JsonValue;
  structuredOutput?: JsonValue;
  structuredOutputSchemaDigest?: string;
  turnFinalization?: SessionTurnFinalizationInfo;
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

export type SessionTurnKind = 'user' | 'pending' | 'goal';

export interface SessionTurnStartInfo {
  turnId: string;
  kind: SessionTurnKind;
  startedAt: string;
  inputMessageIds?: string[];
}

export interface SessionTurnMetrics {
  turnsCount: number;
  toolCallsCount: number;
  durationMs: number;
}

export interface SessionTurnCompletionInfo extends SessionTurnMetrics {
  turnId: string;
  completedAt: string;
}

export interface SessionGoalFinalizationInfo {
  goalId: string;
  verificationAttempt: number;
  verifierSessionId: string;
  evidenceSha256: string;
  goalUpdatedAt: string;
}

export interface SessionTurnFinalizationInfo extends SessionTurnMetrics {
  turnId: string;
  inputMessageIds: string[];
  goalFinalization?: SessionGoalFinalizationInfo;
}

export type SessionTurnAbortCause =
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'process_restart';

export interface SessionTurnAbortInfo extends SessionTurnMetrics {
  turnId: string;
  cause: SessionTurnAbortCause;
  abortedAt: string;
  acknowledgedInputMessageIds?: string[];
  recovery?:
    | {
        version: 1;
        inputMessageIds: string[];
        hadSuccessfulToolResult: boolean;
        emptyFinalCorrectionSpent: boolean;
      }
    | {
        version: 2;
        inputMessageIds: string[];
        hadSuccessfulToolResult: boolean;
        interruptedToolCallCount: number;
        emptyFinalCorrectionSpent: boolean;
      };
}

export interface SessionTurnRecoveryAcknowledgementInfo {
  turnId: string;
  acknowledgedAt: string;
}

export interface SubagentRunRef {
  subagentSessionId: string;
  subagentType: string;
  subagentDescription?: string;
  subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  subagentSummary?: string;
  subagentResumedFrom?: string;
  subagentRootId?: string;
  subagentResumeDepth?: number;
  verificationVerdict?: 'pass' | 'fail' | 'partial';
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

export type TokenBudgetHandoffRecordedEvent = SessionEventBase & {
  type: 'token_budget_handoff_recorded';
  data: JsonObject;
};

export type SessionEvent =
  | TokenBudgetHandoffRecordedEvent
  | (SessionEventBase & { type: 'session_created'; data: SessionInfo })
  | (SessionEventBase & { type: 'session_updated'; data: Partial<SessionInfo> })
  | (SessionEventBase & { type: 'session_rewound'; data: SessionRewindInfo })
  | (SessionEventBase & { type: 'turn_started'; data: SessionTurnStartInfo })
  | (SessionEventBase & {
      type: 'turn_completed';
      data: SessionTurnCompletionInfo;
    })
  | (SessionEventBase & { type: 'turn_aborted'; data: SessionTurnAbortInfo })
  | (SessionEventBase & {
      type: 'turn_recovery_acknowledged';
      data: SessionTurnRecoveryAcknowledgementInfo;
    })
  | (SessionEventBase & {
      type: 'inbox_acknowledged';
      data: InboxAcknowledgementInfo;
    })
  | (SessionEventBase & {
      type: 'interaction_requested';
      data: SessionInteractionRequestInfo;
    })
  | (SessionEventBase & {
      type: 'interaction_responded';
      data: SessionInteractionResponseInfo;
    })
  | (SessionEventBase & {
      type: 'interaction_recovered';
      data: SessionInteractionRecoveryInfo;
    })
  | (SessionEventBase & {
      type: 'review_started';
      data: SessionReviewStartInfo;
    })
  | (SessionEventBase & {
      type: 'review_completed';
      data: SessionReviewCompletionInfo;
    })
  | (SessionEventBase & { type: 'message_created'; data: MessageInfo })
  | (SessionEventBase & { type: 'part_created'; data: PartInfo })
  | (SessionEventBase & { type: 'part_updated'; data: PartInfo });

export function turnAbortAppliedAcknowledgements(
  source: readonly SessionEvent[],
  abortIndex: number
): string[] {
  const aborted = source[abortIndex];
  if (aborted?.type !== 'turn_aborted') return [];
  const acknowledgedInputMessageIds = parseTurnAbortAcknowledgedInputMessageIds(
    aborted.data
  );
  if (acknowledgedInputMessageIds.length === 0) return [];

  let turnStartIndex = -1;
  for (let index = abortIndex - 1; index >= 0; index--) {
    const event = source[index];
    if (event.type === 'turn_started') {
      if (event.data.turnId !== aborted.data.turnId) return [];
      turnStartIndex = index;
      break;
    }
    if (event.type === 'turn_completed' || event.type === 'turn_aborted') return [];
  }
  if (turnStartIndex < 0) return [];

  const appliedInputMessageIds = new Set<string>();
  for (let index = turnStartIndex + 1; index < abortIndex; index++) {
    const event = source[index];
    if (event.type !== 'message_created' || event.data.role !== 'user') continue;
    const metadata = event.data.metadata;
    const inboxMessageId =
      event.data.inboxMessageId !== undefined
        ? event.data.inboxMessageId
        : metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
          ? metadata.inboxMessageId
          : undefined;
    if (
      typeof inboxMessageId === 'string' &&
      inboxMessageId.length > 0 &&
      inboxMessageId.length <= MAX_TURN_INPUT_MESSAGE_ID_CHARS
    ) {
      appliedInputMessageIds.add(inboxMessageId);
    }
  }

  return acknowledgedInputMessageIds.filter((messageId) =>
    appliedInputMessageIds.has(messageId)
  );
}
