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
import type { SessionMetadata } from '../services/SessionService.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';

// ==================== Session Types ====================

/**
 * 消息角色类型
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

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
 */
export interface SessionState {
  sessionId: string;
  messages: SessionMessage[];
  isThinking: boolean; // 临时状态 - 不持久化
  isCompacting: boolean; // 是否正在压缩上下文
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;
  tokenUsage: TokenUsage; // Token 使用量统计
}

/**
 * 会话 Actions
 */
export interface SessionActions {
  addMessage: (message: SessionMessage) => void;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  addToolMessage: (content: string, metadata?: ToolMessageMetadata) => void;
  setThinking: (isThinking: boolean) => void;
  setCompacting: (isCompacting: boolean) => void;
  setCommand: (command: string | null) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  resetSession: () => void;
  restoreSession: (sessionId: string, messages: SessionMessage[]) => void;
  updateTokenUsage: (usage: Partial<TokenUsage>) => void;
  resetTokenUsage: () => void;
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
  | 'todoPanel'
  | 'shortcuts'
  | 'modelSelector'
  | 'modelAddWizard'
  | 'modelEditWizard'
  | 'agentsManager'
  | 'agentCreationWizard';

/**
 * 应用状态（纯 UI 状态）
 */
export interface AppState {
  initializationStatus: InitializationStatus;
  initializationError: string | null;
  activeModal: ActiveModal;
  sessionSelectorData: SessionMetadata[] | undefined;
  modelEditorTarget: ModelConfig | null;
  todos: TodoItem[];
  awaitingSecondCtrlC: boolean; // 是否等待第二次 Ctrl+C 退出
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
  setTodos: (todos: TodoItem[]) => void;
  updateTodo: (todo: TodoItem) => void;
  setAwaitingSecondCtrlC: (awaiting: boolean) => void;
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
 * 命令执行状态
 */
export interface CommandState {
  isProcessing: boolean; // 临时状态 - 不持久化
  abortController: AbortController | null; // 不持久化
  pendingCommands: string[]; // 待处理命令队列 - 不持久化
}

/**
 * 命令 Actions
 */
export interface CommandActions {
  setProcessing: (isProcessing: boolean) => void;
  createAbortController: () => AbortController;
  clearAbortController: () => void;
  abort: () => void;
  enqueueCommand: (command: string) => void;
  dequeueCommand: () => string | undefined;
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
}

// ==================== Utility Types ====================

/**
 * 获取 Store 的状态部分（不包含 actions）
 */
export type BladeStoreState = {
  session: SessionState;
  app: AppState;
  config: ConfigState;
  focus: FocusState;
  command: CommandState;
};

/**
 * 重导出 PermissionMode 以便使用
 */
export { PermissionMode };
