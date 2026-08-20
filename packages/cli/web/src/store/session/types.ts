import type { McpElicitationDetails, SessionRef } from '@api/schemas';
import type { StateCreator } from 'zustand';
import type {
  Message as BaseMessage,
  BoundProject,
  CodeReviewDispatchInput,
  Goal,
  ImageAttachmentInput,
  MessageContent,
  MessageContentPart,
  PermissionMode,
  SendMessagePayload,
  Session,
  SessionRewindMode,
  StreamEvent,
  TaskDispatchInput,
  TaskEventConnectionState,
  WorkspaceInfo,
} from '@/services';

export type {
  BoundProject,
  CodeReviewDispatchInput,
  Goal,
  ImageAttachmentInput,
  MessageContent,
  MessageContentPart,
  PermissionMode,
  SendMessagePayload,
  Session,
  SessionRef,
  SessionRewindMode,
  StreamEvent,
  TaskDispatchInput,
  TaskEventConnectionState,
  WorkspaceInfo,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  isDefaultMaxTokens: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheBreak?: PromptCacheBreakInfo;
  estimatedCostUsd: number;
}

export interface TokenUsageUpdate extends Partial<TokenUsage> {
  costUsd?: number;
}

export interface PromptCacheBreakInfo {
  reason:
    | 'model_changed'
    | 'system_prompt_changed'
    | 'tools_changed'
    | 'request_policy_changed'
    | 'ttl_expired'
    | 'server_side';
  previousCacheReadTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokenDrop: number;
  elapsedMs: number;
  callNumber: number;
}

export type AgentPhase =
  | 'idle'
  | 'running'
  | 'compacting'
  | 'recovering_context'
  | 'switching_model'
  | 'waiting_permission'
  | 'error';

export interface ProviderRetryInfo {
  phase: 'scheduled' | 'waiting' | 'attempt' | 'exhausted';
  attempt: number;
  maxRetries: number;
  delayMs?: number;
  mode?: 'standard' | 'bounded_foreground';
  recoveryBudgetMs?: number;
  recoveryElapsedMs?: number;
  recoveryRemainingMs?: number;
  exhaustedBy?: 'attempt_limit' | 'recovery_budget';
}

export interface ProviderAdmissionInfo {
  phase: 'queued' | 'admitted' | 'rejected';
  requestClass: 'foreground' | 'background' | 'internal';
  resource: 'stream' | 'pending_count' | 'pending_bytes';
  scope: 'global' | 'domain' | 'owner' | 'class';
  reason?: 'capacity' | 'queue_full' | 'wait_timeout' | 'closed';
  queuePosition: number;
  queueDepth: number;
  inFlight: number;
  limit: number;
  waitMs: number;
  maxWaitMs: number;
  recoveryRemainingMs?: number;
}

export interface ProviderCircuitInfo {
  phase: 'opened' | 'waiting' | 'probe' | 'closed' | 'reopened' | 'rejected';
  reason: 'rate_limit' | 'server_error' | 'transport' | 'stream_closed';
  statusCode?: number;
  retryAfterMs?: number;
  nextProbeAt?: number;
  openDurationMs: number;
  sampleCount?: number;
  failureCount?: number;
  recoveryRemainingMs?: number;
}

export interface ProviderStallInfo {
  phase: 'detected';
  stallCount: number;
  durationMs: number;
  warningAfterMs: number;
  timeoutMs: number;
  outputStarted: boolean;
}

export interface ActionStationarityInfo {
  phase: 'detected' | 'halted';
  toolName: string;
  runLength: number;
  nudgeThreshold: number;
  haltThreshold: number;
  progressAware: boolean;
}

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface SubagentProgress {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  currentTool?: string;
  startTime: number;
  sessionId?: string;
  resumedFrom?: string;
  rootAgentId?: string;
  resumeDepth?: number;
  verificationVerdict?: 'pass' | 'fail' | 'partial';
  output?: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
}

export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  arguments?: string;
  toolKind?: string;
  status: 'running' | 'success' | 'error';
  summary?: string;
  progress?: number;
  progressTotal?: number;
  progressMessage?: string;
  admission?: {
    kind: 'readonly' | 'write' | 'execute';
    scope: 'global' | 'session';
    queuePosition: number;
    inFlight: number;
    limit: number;
  };
  output?: string;
  startTime: number;
  metadata?: Record<string, unknown>;
}

export type AgentTimelineBlock =
  | {
      id: string;
      type: 'thinking';
      content: string;
    }
  | {
      id: string;
      type: 'text';
      content: string;
    }
  | {
      id: string;
      type: 'tool_group';
      toolCallIds: string[];
    };

export interface AgentResponseContent {
  /** Ordered presentation projection. Legacy fields below remain for compatibility. */
  timeline?: AgentTimelineBlock[];
  textBefore: string;
  toolCalls: ToolCallInfo[];
  textAfter: string;
  thinkingContent: string;
  tasks: TaskItem[];
  subagent: SubagentProgress | null;
  subagents?: SubagentProgress[];
  confirmation: ConfirmationInfo | null;
  question: QuestionInfo | null;
  elicitation?: ElicitationInfo | null;
}

export interface ConfirmationInfo {
  toolCallId: string;
  toolName: string;
  description: string;
  diff?: string;
  allowRemember?: boolean;
  status: 'pending' | 'approved' | 'denied';
}

export interface QuestionInfo {
  toolCallId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  status: 'pending' | 'answered';
  answers?: Record<string, string | string[]>;
}

export interface ElicitationInfo {
  toolCallId: string;
  details: McpElicitationDetails;
  status: 'pending' | 'responded' | 'cancelled';
}

export interface Message extends Omit<BaseMessage, 'metadata'> {
  metadata?: Record<string, unknown>;
  agentContent?: AgentResponseContent;
}

export type CatalogLoadState = 'idle' | 'loading' | 'hydrating' | 'ready' | 'error';

export type SessionErrorKind =
  | 'submission'
  | 'execution'
  | 'interaction'
  | 'task_action'
  | 'navigation'
  | 'generic';

export interface SessionErrorContext {
  kind: SessionErrorKind;
  sessionRef?: SessionRef;
  failureCode?: NonNullable<Session['taskFailure']>['code'];
}

export interface SessionSlice {
  sessions: Session[];
  archivedSessions: Session[];
  currentSessionId: string | null;
  currentSessionRef: SessionRef | null;
  forkingSessionRef: SessionRef | null;
  isTemporarySession: boolean;
  isLoading: boolean;
  catalogLoadState: CatalogLoadState;
  catalogError: string | null;
  archivedCatalogLoadState: CatalogLoadState;
  archivedCatalogError: string | null;
  error: string | null;
  errorContext: SessionErrorContext | null;
  goal: Goal | null;

  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  removeSession: (ref: SessionRef) => void;
  setCurrentSession: (ref: SessionRef | null) => void;
  setTemporarySession: (isTemp: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  getNavigationVersion: () => number;
  startTemporarySession: (projectPath?: string) => void;
  clearError: () => void;
  setGoal: (goal: Goal | null) => void;
  loadSessions: () => Promise<void>;
  loadArchivedSessions: () => Promise<void>;
  selectSession: (ref: SessionRef) => Promise<void>;
  resyncSessionMessages: (ref: SessionRef) => Promise<void>;
  archiveSession: (ref: SessionRef) => Promise<void>;
  unarchiveSession: (ref: SessionRef) => Promise<void>;
  deleteSession: (ref: SessionRef) => Promise<void>;
  updateSession: (ref: SessionRef, title: string) => Promise<void>;
  forkSession: (session: Session) => Promise<void>;
  rewindSession: (targetMessageId: string, mode: SessionRewindMode) => Promise<boolean>;
  sendMessage: (payload: SendMessagePayload) => Promise<boolean>;
  abortSession: () => Promise<boolean>;
  pauseGoal: () => Promise<void>;
  resumeGoal: () => Promise<void>;
  editGoal: (objective: string) => Promise<void>;
  clearGoal: () => Promise<void>;
}

export interface TaskListSlice {
  taskEventsConnected: boolean;
  taskEventConnectionState: TaskEventConnectionState;
  taskEventUnsubscribe: (() => void) | null;
  taskWorkspaceInfo: WorkspaceInfo | null;
  isTaskWorkspaceLoading: boolean;
  taskWorkspaceError: string | null;
  boundProjects: BoundProject[];
  selectedProjectPath: string | null;
  isDispatchingTask: boolean;
  isBindingProject: boolean;
  cancellingTaskKeys: string[];
  retryingTaskKeys: string[];
  taskDeliveryActions: Record<string, 'apply' | 'discard'>;
  unreadTaskKeys: string[];

  subscribeToTaskEvents: () => Promise<void>;
  reconnectTaskEvents: () => Promise<void>;
  unsubscribeFromTaskEvents: () => void;
  handleTaskEvent: (event: StreamEvent) => void;
  loadTaskWorkspaceInfo: () => Promise<void>;
  loadBoundProjects: () => Promise<void>;
  bindProject: (projectPath: string) => Promise<void>;
  unbindProject: (projectPath: string) => Promise<void>;
  selectProject: (projectPath: string) => void;
  cancelTask: (ref: SessionRef) => Promise<void>;
  retryTask: (ref: SessionRef) => Promise<void>;
  deliverTask: (ref: SessionRef, action: 'apply' | 'discard') => Promise<void>;
  markTaskRead: (ref: SessionRef) => void;
  clearUnreadTasks: () => void;
  dispatchTask: (input: TaskDispatchInput) => Promise<void>;
  startCodeReview: (input: CodeReviewDispatchInput) => Promise<void>;
}

export interface MessageSlice {
  messages: Message[];

  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  appendDelta: (id: string, delta: string, position: 'before' | 'after') => void;
  appendToolCall: (id: string, toolCall: ToolCallInfo) => void;
  updateToolCall: (
    messageId: string,
    toolCallId: string,
    updates: Partial<ToolCallInfo>
  ) => void;
  appendThinking: (id: string, delta: string) => void;
  setConfirmation: (id: string, confirmation: ConfirmationInfo | null) => void;
  setQuestion: (id: string, question: QuestionInfo | null) => void;
  setElicitation: (id: string, elicitation: ElicitationInfo | null) => void;
  setSubagent: (id: string, subagent: SubagentProgress | null) => void;
  updateSubagent: (
    id: string,
    subagentId: string,
    update:
      | Partial<SubagentProgress>
      | ((current: SubagentProgress) => Partial<SubagentProgress>)
  ) => void;
  setTasks: (id: string, tasks: TaskItem[]) => void;
  replaceTemp: (content: MessageContent, message: Message) => void;
}

export interface StreamingSlice {
  isStreaming: boolean;
  isStopping: boolean;
  agentPhase: AgentPhase;
  providerAdmission: ProviderAdmissionInfo | null;
  providerCircuit: ProviderCircuitInfo | null;
  providerRetry: ProviderRetryInfo | null;
  providerStall: ProviderStallInfo | null;
  actionStationarity: ActionStationarityInfo | null;
  sessionEventConnectionState: TaskEventConnectionState | 'idle';
  currentRunId: string | null;
  pendingSteeringCount: number;
  pendingInputDelivery: 'current_turn' | 'next_turn' | null;
  recoveredSteeringCount: number;
  pendingSubagentCompletions?: Record<string, Record<string, unknown>>;
  eventUnsubscribe: (() => void) | null;
  currentAssistantMessageId: string | null;
  hasToolCalls: boolean;

  setStreaming: (streaming: boolean) => void;
  setAgentPhase: (phase: AgentPhase) => void;
  setRunId: (runId: string | null) => void;
  prepareEventSubscription: (
    ref: SessionRef,
    onEvent?: (event: StreamEvent) => void
  ) => Promise<() => void>;
  replaceEventSubscription: (next: (() => void) | null) => void;
  subscribeToEvents: (ref: SessionRef) => Promise<void>;
  reconnectSessionEvents: () => Promise<void>;
  unsubscribeFromEvents: () => void;
  handleEvent: (event: StreamEvent) => void;
  setCurrentAssistantMessageId: (id: string | null) => void;
  setHasToolCalls: (has: boolean) => void;
  startAgentResponse: (messageId: string) => void;
  endAgentResponse: () => void;
}

export interface UiSlice {
  tokenUsage: TokenUsage;

  updateTokenUsage: (usage: TokenUsageUpdate) => void;
  resetContextUsage: () => void;
  setMaxContextTokens: (tokens: number, isDefault?: boolean) => void;
}

export type SessionStoreState = SessionSlice &
  TaskListSlice &
  MessageSlice &
  StreamingSlice &
  UiSlice;

export type SliceCreator<T> = StateCreator<SessionStoreState, [], [], T>;
