/**
 * Blade Store 类型定义 <p> 遵循准则： 1. 只暴露 actions - 不直接暴露 set 2. 强选择器约束 - 使用选择器访问状态 3. Store
 * 是内存单一数据源 - 持久化通过 ConfigManager/vanilla.ts actions 4. vanilla store 对外 - 供 Agent 使用
 */

import type { ActionStationarityEvent } from '../agent/loop/actionStationarity.js';
import type { TeamSnapshot } from '../agent/teams/TeamRuntime.js';
import type {
  FollowUpQueueErrorCode,
  FollowUpQueueSnapshot,
} from '../api/followUpQueueSchemas.js';
import type { ProviderRecoveryProjection } from '../api/providerRecoverySchemas.js';
import type { SessionSurfaceSummary } from '../api/sessionSurfaceSchemas.js';
import type { TurnActivityProjection } from '../api/turnActivitySchemas.js';
import type {
  CommunicationStyleSelection,
  ModelConfig,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  RuntimeConfig,
  ServiceTierSelection,
} from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { EphemeralDelta } from '../context/events/EphemeralDelta.js';
import type { SessionEvent } from '../context/types.js';
import type {
  Message,
  PromptCacheBreakInfo,
} from '../services/ChatServiceInterface.js';
import type { ProviderCircuitEvent } from '../services/pi/providerCircuitBreaker.js';
import type { ProviderAdmissionEvent } from '../services/pi/providerRequestAdmission.js';
import type { ProviderRetryEvent } from '../services/pi/providerRetry.js';
import type { ProviderStallEvent } from '../services/pi/providerStall.js';
import type { SideConversationResult } from '../services/SideConversationService.js';
import type { SessionSelectionIntent } from '../slash-commands/types.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import type { ToolProgressUpdate } from '../tools/types/ExecutionTypes.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export interface ToolMessageMetadata {
  toolCallId?: string;
  toolName: string;
  phase: 'start' | 'progress' | 'complete';
  summary?: string;
  detail?: string;
  params?: Record<string, unknown>;
  admission?: ToolProgressUpdate['admission'];
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown> | ToolMessageMetadata;
  thinkingContent?: string; // Thinking 模型的推理过程内容
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheBreak?: PromptCacheBreakInfo;
  turnCount: number;
  estimatedCostUsd: number;
}

export interface TokenUsageUpdate extends Partial<TokenUsage> {
  scope?: 'main' | 'auxiliary';
  /** 本次模型调用费用；优先使用 pi-ai 的精确计算结果。 */
  costUsd?: number;
}

export interface SessionState {
  sessionId: string;
  workspaceRoot: string;
  messages: SessionMessage[];
  restoredContextMessages: Message[] | null; // resume 时保留的原始上下文（含 summary / multimodal）
  restoredVisibleMessageCount: number; // messages 中来自 restoreSession 的可见消息数
  isCompacting: boolean; // 是否正在压缩上下文
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;
  tokenUsage: TokenUsage; // Token 使用量统计
  currentThinkingContent: string | null; // 当前正在接收的 thinking 内容（流式）
  thinkingExpanded: boolean; // thinking 内容是否展开显示
  clearCount: number; // 清屏计数器（用于强制 Static 组件重新挂载）
  historyExpanded: boolean; // 是否展开所有历史消息（默认 false，只显示最近 N 条）
  expandedMessageCount: number; // 始终保持展开的最近消息数量（默认 30）
  currentStreamingMessageId: string | null; // 当前正在流式接收的助手消息 ID
  currentStreamingChunks: string[]; // NEW: 累积的原始增量片段（用于最终拼接）
  currentStreamingLines: string[]; // NEW: 已完成行的缓冲区
  currentStreamingTail: string; // NEW: 当前未完成的行片段
  currentStreamingLineCount: number; // NEW: 已完成行总数（包含被裁剪的历史行）
  currentStreamingVersion: number; // NEW: 流式缓冲版本号（用于触发订阅更新）
  finalizingStreamingMessageId: string | null; // 正在从流式切换到最终渲染的消息 ID
  providerAdmission: ProviderAdmissionEvent | null; // Provider physical stream capacity 状态
  providerCircuit: ProviderCircuitEvent | null; // 进程共享 Provider failure-domain 状态
  providerRetry: ProviderRetryEvent | null; // 首字节前可安全重放的 Provider retry 状态
  providerStall: ProviderStallEvent | null; // Provider 流事件间隙的可恢复 stall 状态
  providerRecovery: ProviderRecoveryProjection | null; // Runtime-owned Provider 恢复快照
  turnActivity: TurnActivityProjection | null; // Runtime-owned 当前回合活动快照
  actionStationarity: ActionStationarityEvent | null; // 连续工具调用无进展状态
}

export interface SessionActions {
  addMessage: (message: SessionMessage) => void;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string, thinkingContent?: string) => void;
  replaceLastAssistantMessage: (content: string) => void;
  addAssistantMessageAndClearThinking: (content: string) => void;
  addToolMessage: (content: string, metadata?: ToolMessageMetadata) => void;
  setCompacting: (isCompacting: boolean) => void;
  setCommand: (command: string | null) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  setCompactedContext: (messages: Message[]) => void;
  resetSession: () => void;
  restoreSession: (
    sessionId: string,
    messages: SessionMessage[],
    restoredContextMessages?: Message[],
    workspaceRoot?: string
  ) => void;
  updateTokenUsage: (usage: TokenUsageUpdate) => void;
  resetContextUsage: () => void;
  resetTokenUsage: () => void;
  setCurrentThinkingContent: (content: string | null) => void;
  appendThinkingContent: (delta: string) => void;
  setThinkingExpanded: (expanded: boolean) => void;
  toggleThinkingExpanded: () => void;
  setHistoryExpanded: (expanded: boolean) => void;
  toggleHistoryExpanded: () => void;
  setExpandedMessageCount: (count: number) => void;
  incrementClearCount: () => void;
  startStreamingAssistantMessage: () => string; // 开始流式助手消息，返回消息 ID
  appendAssistantContent: (delta: string) => string; // 追加内容到当前流式消息
  finalizeStreamingMessage: (extraContent?: string, extraThinking?: string) => void; // 完成流式消息（可追加缓冲区剩余内容）
  clearFinalizingStreamingMessageId: () => void; // 清理最终渲染标记
  discardStreamingMessage: () => void; // 丢弃流式消息（不提交，用于模型降级场景）
  setProviderCircuit: (circuit: ProviderCircuitEvent | null) => void;
  setProviderAdmission: (admission: ProviderAdmissionEvent | null) => void;
  setProviderRetry: (retry: ProviderRetryEvent | null) => void;
  setProviderStall: (stall: ProviderStallEvent | null) => void;
  setProviderRecovery: (recovery: ProviderRecoveryProjection | null) => void;
  setTurnActivity: (activity: TurnActivityProjection | null) => void;
  setActionStationarity: (stationarity: ActionStationarityEvent | null) => void;
  // 事件溯源投影 actions (CQRS read-model)
  applyCommittedEvent: (event: SessionEvent) => void; // 折叠 committed 事件到投影
  applyStreamingDelta: (delta: EphemeralDelta) => void; // 叠加 ephemeral streaming delta
  resetConversationProjection: () => void; // 重置投影中间态
}

export interface SessionSlice extends SessionState {
  actions: SessionActions;
}

export interface ConfigState {
  config: RuntimeConfig | null;
}

export interface ConfigActions {
  setConfig: (config: RuntimeConfig) => void;
  updateConfig: (partial: Partial<RuntimeConfig>) => void;
}

export interface ConfigSlice extends ConfigState {
  actions: ConfigActions;
}

export type InitializationStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'needsSetup'
  | 'error';
export type ActiveModal =
  | 'none'
  | 'themeSelector'
  | 'permissionsManager'
  | 'sessionSelector'
  | 'sessionHistoryViewer'
  | 'followUpQueue'
  | 'taskPanel'
  | 'shortcuts'
  | 'modelSelector'
  | 'modelAddWizard'
  | 'modelEditWizard'
  | 'agentsManager'
  | 'agentCreationWizard'
  | 'skillsManager'
  | 'hooksManager'
  | 'pluginsManager';
export interface SubagentProgress {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  currentTool?: string;
  terminalSummary?: string;
  startTime: number;
}

export interface SessionSelectorState {
  intent: SessionSelectionIntent;
  sessions: SessionSurfaceSummary[];
}

export interface SessionHistoryViewerState {
  intent: SessionSelectionIntent;
  session: SessionSurfaceSummary;
}

export interface SideConversationState {
  requestId: string;
  question: string;
  status: 'loading' | 'completed' | 'error';
  response?: string;
  error?: string;
  durationMs?: number;
}

export interface AppState {
  initializationStatus: InitializationStatus;
  initializationError: string | null;
  activeModal: ActiveModal;
  sessionSelectorData: SessionSelectorState | undefined;
  sessionHistoryViewerData: SessionHistoryViewerState | undefined;
  taskAttentionStatus: 'idle' | 'loading' | 'ready' | 'error';
  taskAttentionUnreadKeys: readonly string[];
  followUpQueue: FollowUpQueueSnapshot | null;
  followUpQueueOwner: string | null;
  followUpQueueMutation: FollowUpQueueMutationState;
  modelEditorTarget: ModelConfig | null;
  tasks: TaskListItem[];
  awaitingSecondCtrlC: boolean; // 是否等待第二次 Ctrl+C 退出
  reasoningEffort: ReasoningEffortSelection;
  serviceTier: ServiceTierSelection;
  responseVerbosity: ResponseVerbositySelection;
  communicationStyle: CommunicationStyleSelection;
  subagentProgress: SubagentProgress | null; // 兼容投影：最近一条 subagent
  subagentProgresses: Record<string, SubagentProgress>;
  sideConversation: SideConversationState | null;
  teams: TeamSnapshot[];
}

export interface AppActions {
  setInitializationStatus: (status: InitializationStatus) => void;
  setInitializationError: (error: string | null) => void;
  setActiveModal: (modal: ActiveModal) => void;
  showSessionSelector: (
    sessions: SessionSurfaceSummary[],
    intent?: SessionSelectionIntent
  ) => void;
  showSessionHistoryViewer: (
    session: SessionSurfaceSummary,
    intent?: SessionSelectionIntent
  ) => void;
  showModelEditWizard: (model: ModelConfig) => void;
  closeModal: () => void;
  setTasks: (tasks: TaskListItem[]) => void;
  updateTask: (task: TaskListItem) => void;
  setAwaitingSecondCtrlC: (awaiting: boolean) => void;
  projectTaskAttentionState: (
    status: AppState['taskAttentionStatus'],
    unreadKeys: readonly string[],
    sessions: readonly SessionSurfaceSummary[]
  ) => void;
  projectFollowUpQueue: (snapshot: FollowUpQueueSnapshot, owner?: string) => void;
  claimFollowUpQueueOwner: (owner: string) => void;
  setFollowUpQueueMutation: (
    mutation: FollowUpQueueMutationState,
    owner?: string
  ) => void;
  clearFollowUpQueue: (owner?: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSelection) => void;
  setServiceTier: (tier: ServiceTierSelection) => void;
  setResponseVerbosity: (verbosity: ResponseVerbositySelection) => void;
  setCommunicationStyle: (style: CommunicationStyleSelection) => void;
  setThinkingModeEnabled: (enabled: boolean) => void;
  toggleThinkingMode: () => void;
  startSubagentProgress: (id: string, type: string, description: string) => void;
  updateSubagentTool: (id: string, toolName: string) => void;
  completeSubagentProgress: (
    id: string,
    success: boolean,
    terminalSummary?: string
  ) => void;
  startSideConversation: (requestId: string, question: string) => void;
  completeSideConversation: (requestId: string, result: SideConversationResult) => void;
  failSideConversation: (requestId: string, error: string) => void;
  dismissSideConversation: () => void;
  setTeams: (teams: TeamSnapshot[]) => void;
}

export interface AppSlice extends AppState {
  actions: AppActions;
}

export enum FocusId {
  MAIN_INPUT = 'main-input',
  TRANSCRIPT_PAGER = 'transcript-pager',
  SESSION_SELECTOR = 'session-selector',
  SESSION_HISTORY_VIEWER = 'session-history-viewer',
  FOLLOW_UP_QUEUE = 'follow-up-queue',
  CONFIRMATION_PROMPT = 'confirmation-prompt',
  THEME_SELECTOR = 'theme-selector',
  MODEL_SELECTOR = 'model-selector',
  MODEL_CONFIG_WIZARD = 'model-config-wizard',
  PERMISSIONS_MANAGER = 'permissions-manager',
  AGENTS_MANAGER = 'agents-manager',
  AGENT_CREATION_WIZARD = 'agent-creation-wizard',
  SKILLS_MANAGER = 'skills-manager',
  PLUGINS_MANAGER = 'plugins-manager',
  HOOKS_MANAGER = 'hooks-manager',
}

export interface FocusState {
  currentFocus: FocusId;
  previousFocus: FocusId | null;
}

export interface FocusActions {
  setFocus: (id: FocusId) => void;
  restorePreviousFocus: () => void;
}

export interface FocusSlice extends FocusState {
  actions: FocusActions;
}

export interface FollowUpPresentation {
  displayText: string;
  text: string;
  images: Array<{ id: number; base64: string; mimeType: string }>;
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; id: number; base64: string; mimeType: string }
  >;
}

export interface FollowUpQueueMutationState {
  pending: boolean;
  messageId?: string;
  errorCode?: FollowUpQueueErrorCode;
  errorMessage?: string;
  supersededVersions?: readonly string[];
}

export interface CommandState {
  isProcessing: boolean; // 临时状态 - 不持久化
  abortController: AbortController | null; // 不持久化
  followUpPresentations: Record<string, FollowUpPresentation>; // 仅用于等待 durable apply 的展示缓存
  recoveredSteeringCount: number;
}

export interface CommandActions {
  setProcessing: (isProcessing: boolean) => void;
  createAbortController: () => AbortController;
  getAbortController: () => AbortController | null;
  /**
   * 清理 AbortController
   * @param expectedController 可选，只有当 store 中的 controller 与此相同时才清除
   * 用于防止新任务的 controller 被旧任务的 finally 块误清
   */
  clearAbortController: (expectedController?: AbortController) => void;
  abort: (reason?: string) => void;
  rememberFollowUpPresentation: (
    messageId: string,
    command: FollowUpPresentation
  ) => void;
  takeFollowUpPresentation: (messageId: string) => FollowUpPresentation | undefined;
  clearFollowUpPresentations: () => void;
  setRecoveredSteeringCount: (count: number) => void;
}

export interface CommandSlice extends CommandState {
  actions: CommandActions;
}

export interface BladeStore {
  session: SessionSlice;
  app: AppSlice;
  config: ConfigSlice;
  focus: FocusSlice;
  command: CommandSlice;
}

export { PermissionMode };
