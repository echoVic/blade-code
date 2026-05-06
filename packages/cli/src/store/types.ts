/**
 * Blade Store 类型定义
 *
 * 遵循准则：
 * 1. 只暴露 actions - 不直接暴露 set
 * 2. 强选择器约束 - 使用选择器访问状态
 * 3. Store 是内存单一数据源 - 持久化通过 ConfigManager/vanilla.ts actions
 * 4. vanilla store 对外 - 供 Agent 使用
 */

import type { ModelConfig, RuntimeConfig } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { SessionMetadata } from '../services/SessionService.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import type { SpecSlice } from './slices/specSlice.js';

// ==================== Session Types ====================

/**
 * 消息角色类型
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

// ==================== JSON Types ====================

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * 工具消息元数据
 */
export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete';
  summary?: string;
  detail?: string;
  params?: Record<string, unknown>;
}

/**
 * 会话消息
 */
export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown> | ToolMessageMetadata;
  thinkingContent?: string; // Thinking 模型的推理过程内容
}

/**
 * Token 使用量统计
 */
export interface TokenUsage {
  inputTokens: number; // 当前 prompt tokens
  outputTokens: number; // 当前 completion tokens
  totalTokens: number; // 累计总 tokens
  maxContextTokens: number; // 上下文窗口大小
}

/**
 * 会话状态
 *
 * 注意：isThinking 已合并到 CommandState.isProcessing
 */
export interface SessionState {
  sessionId: string;
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
  // 历史消息折叠相关
  historyExpanded: boolean; // 是否展开所有历史消息（默认 false，只显示最近 N 条）
  expandedMessageCount: number; // 始终保持展开的最近消息数量（默认 30）
  // 流式消息相关
  currentStreamingMessageId: string | null; // 当前正在流式接收的助手消息 ID
  currentStreamingChunks: string[]; // NEW: 累积的原始增量片段（用于最终拼接）
  currentStreamingLines: string[]; // NEW: 已完成行的缓冲区
  currentStreamingTail: string; // NEW: 当前未完成的行片段
  currentStreamingLineCount: number; // NEW: 已完成行总数（包含被裁剪的历史行）
  currentStreamingVersion: number; // NEW: 流式缓冲版本号（用于触发订阅更新）
  finalizingStreamingMessageId: string | null; // 正在从流式切换到最终渲染的消息 ID
}

/**
 * 会话 Actions
 */
export interface SessionActions {
  addMessage: (message: SessionMessage) => void;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string, thinkingContent?: string) => void;
  /** 添加助手消息并同时清空 thinking 内容（原子操作，避免闪烁） */
  addAssistantMessageAndClearThinking: (content: string) => void;
  addToolMessage: (content: string, metadata?: ToolMessageMetadata) => void;
  setCompacting: (isCompacting: boolean) => void;
  setCommand: (command: string | null) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  resetSession: () => void;
  restoreSession: (
    sessionId: string,
    messages: SessionMessage[],
    restoredContextMessages?: Message[]
  ) => void;
  updateTokenUsage: (usage: Partial<TokenUsage>) => void;
  resetTokenUsage: () => void;
  // Thinking 相关 actions
  setCurrentThinkingContent: (content: string | null) => void;
  appendThinkingContent: (delta: string) => void;
  setThinkingExpanded: (expanded: boolean) => void;
  toggleThinkingExpanded: () => void;
  // 历史消息折叠相关 actions
  setHistoryExpanded: (expanded: boolean) => void;
  toggleHistoryExpanded: () => void;
  setExpandedMessageCount: (count: number) => void;
  // Static 组件刷新相关 actions
  incrementClearCount: () => void;
  // 流式消息相关 actions
  startStreamingAssistantMessage: () => string; // 开始流式助手消息，返回消息 ID
  appendAssistantContent: (delta: string) => string; // 追加内容到当前流式消息
  finalizeStreamingMessage: (extraContent?: string, extraThinking?: string) => void; // 完成流式消息（可追加缓冲区剩余内容）
  clearFinalizingStreamingMessageId: () => void; // 清理最终渲染标记
  discardStreamingMessage: () => void; // 丢弃流式消息（不提交，用于模型降级场景）
}

/**
 * Session Slice 类型
 */
export interface SessionSlice extends SessionState {
  actions: SessionActions;
}

// ==================== Config Types ====================

/**
 * 配置状态
 */
export interface ConfigState {
  config: RuntimeConfig | null;
}

/**
 * 配置 Actions
 */
export interface ConfigActions {
  setConfig: (config: RuntimeConfig) => void;
  updateConfig: (partial: Partial<RuntimeConfig>) => void;
}

/**
 * Config Slice 类型
 */
export interface ConfigSlice extends ConfigState {
  actions: ConfigActions;
}

// ==================== App Types ====================

/**
 * 初始化状态类型
 */
export type InitializationStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'needsSetup'
  | 'error';

/**
 * 活动模态框类型
 */
export type ActiveModal =
  | 'none'
  | 'themeSelector'
  | 'permissionsManager'
  | 'sessionSelector'
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

/**
 * Subagent 进度状态
 */
export interface SubagentProgress {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  currentTool?: string;
  startTime: number;
}

/**
 * 应用状态（纯 UI 状态）
 */
export interface AppState {
  initializationStatus: InitializationStatus;
  initializationError: string | null;
  activeModal: ActiveModal;
  sessionSelectorData: SessionMetadata[] | undefined;
  modelEditorTarget: ModelConfig | null;
  tasks: TaskListItem[];
  awaitingSecondCtrlC: boolean; // 是否等待第二次 Ctrl+C 退出
  thinkingModeEnabled: boolean; // Thinking 模式是否启用（Tab 切换）
  subagentProgress: SubagentProgress | null; // 当前 subagent 执行进度
}

/**
 * 应用 Actions
 */
export interface AppActions {
  setInitializationStatus: (status: InitializationStatus) => void;
  setInitializationError: (error: string | null) => void;
  setActiveModal: (modal: ActiveModal) => void;
  showSessionSelector: (sessions?: SessionMetadata[]) => void;
  showModelEditWizard: (model: ModelConfig) => void;
  closeModal: () => void;
  setTasks: (tasks: TaskListItem[]) => void;
  updateTask: (task: TaskListItem) => void;
  setAwaitingSecondCtrlC: (awaiting: boolean) => void;
  // Thinking 模式相关
  setThinkingModeEnabled: (enabled: boolean) => void;
  toggleThinkingMode: () => void;
  // Subagent 进度相关
  startSubagentProgress: (id: string, type: string, description: string) => void;
  updateSubagentTool: (toolName: string) => void;
  completeSubagentProgress: (success: boolean) => void;
}

/**
 * App Slice 类型
 */
export interface AppSlice extends AppState {
  actions: AppActions;
}

// ==================== Focus Types ====================

/**
 * 焦点 ID 枚举
 */
export enum FocusId {
  MAIN_INPUT = 'main-input',
  SESSION_SELECTOR = 'session-selector',
  CONFIRMATION_PROMPT = 'confirmation-prompt',
  THEME_SELECTOR = 'theme-selector',
  MODEL_SELECTOR = 'model-selector',
  MODEL_CONFIG_WIZARD = 'model-config-wizard',
  PERMISSIONS_MANAGER = 'permissions-manager',
  AGENTS_MANAGER = 'agents-manager',
  AGENT_CREATION_WIZARD = 'agent-creation-wizard',
  HOOKS_MANAGER = 'hooks-manager',
}

/**
 * 焦点状态
 */
export interface FocusState {
  currentFocus: FocusId;
  previousFocus: FocusId | null;
}

/**
 * 焦点 Actions
 */
export interface FocusActions {
  setFocus: (id: FocusId) => void;
  restorePreviousFocus: () => void;
}

/**
 * Focus Slice 类型
 */
export interface FocusSlice extends FocusState {
  actions: FocusActions;
}

// ==================== Command Types ====================

/**
 * 待处理命令（支持图片）
 */
export interface PendingCommand {
  /** 显示文本（带图片占位符，用于 UI 显示） */
  displayText: string;
  /** 纯文本内容（不含图片占位符） */
  text: string;
  /** 图片列表 */
  images: Array<{ id: number; base64: string; mimeType: string }>;
  /** 交错的内容部分列表（保留顺序） */
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; id: number; base64: string; mimeType: string }
  >;
}

/**
 * 命令执行状态
 */
export interface CommandState {
  isProcessing: boolean; // 临时状态 - 不持久化
  abortController: AbortController | null; // 不持久化
  pendingCommands: PendingCommand[]; // 待处理命令队列 - 不持久化
}

/**
 * 命令 Actions
 */
export interface CommandActions {
  setProcessing: (isProcessing: boolean) => void;
  createAbortController: () => AbortController;
  /**
   * 获取当前的 AbortController
   * 用于在 finally 块中检查是否应该重置状态
   */
  getAbortController: () => AbortController | null;
  /**
   * 清理 AbortController
   * @param expectedController 可选，只有当 store 中的 controller 与此相同时才清除
   * 用于防止新任务的 controller 被旧任务的 finally 块误清
   */
  clearAbortController: (expectedController?: AbortController) => void;
  abort: (reason?: string) => void;
  enqueueCommand: (command: PendingCommand) => void;
  dequeueCommand: () => PendingCommand | undefined;
  clearQueue: () => void;
}

/**
 * Command Slice 类型
 */
export interface CommandSlice extends CommandState {
  actions: CommandActions;
}

// ==================== Combined Store ====================

/**
 * Blade Store 完整类型
 */
export interface BladeStore {
  session: SessionSlice;
  app: AppSlice;
  config: ConfigSlice;
  focus: FocusSlice;
  command: CommandSlice;
  spec: SpecSlice;
}

// ==================== Utility Types ====================

export { PermissionMode };
