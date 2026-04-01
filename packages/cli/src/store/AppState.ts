import type { ModelConfig, RuntimeConfig } from '../config/types.js';
import type { SessionMetadata } from '../services/SessionService.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type {
  ActiveModal,
  FocusId,
  InitializationStatus,
  PendingCommand,
  SessionMessage,
  SubagentProgress,
  TokenUsage,
  ToolMessageMetadata,
} from './types.js';
import type {
  SpecActions,
  SpecState,
} from './slices/specSlice.js';

export interface AppState
  extends SessionFields,
    AppFields,
    ConfigFields,
    FocusFields,
    CommandFields,
    SpecFields,
    SessionActionFields,
    AppActionFields,
    ConfigActionFields,
    FocusActionFields,
    CommandActionFields,
    SpecActionFields {}

// ==================== Session ====================

interface SessionFields {
  sessionId: string;
  messages: SessionMessage[];
  isCompacting: boolean;
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;
  tokenUsage: TokenUsage;
  currentThinkingContent: string | null;
  thinkingExpanded: boolean;
  clearCount: number;
  historyExpanded: boolean;
  expandedMessageCount: number;
  currentStreamingMessageId: string | null;
  currentStreamingChunks: string[];
  currentStreamingLines: string[];
  currentStreamingTail: string;
  currentStreamingLineCount: number;
  currentStreamingVersion: number;
  finalizingStreamingMessageId: string | null;
}

interface SessionActionFields {
  addMessage: (message: SessionMessage) => void;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string, thinkingContent?: string) => void;
  addAssistantMessageAndClearThinking: (content: string) => void;
  addToolMessage: (content: string, metadata?: ToolMessageMetadata) => void;
  setCompacting: (isCompacting: boolean) => void;
  setCommand: (command: string | null) => void;
  setSessionError: (error: string | null) => void;
  clearMessages: () => void;
  resetSession: () => void;
  restoreSession: (sessionId: string, messages: SessionMessage[]) => void;
  updateTokenUsage: (usage: Partial<TokenUsage>) => void;
  resetTokenUsage: () => void;
  setCurrentThinkingContent: (content: string | null) => void;
  appendThinkingContent: (delta: string) => void;
  setThinkingExpanded: (expanded: boolean) => void;
  toggleThinkingExpanded: () => void;
  setHistoryExpanded: (expanded: boolean) => void;
  toggleHistoryExpanded: () => void;
  setExpandedMessageCount: (count: number) => void;
  incrementClearCount: () => void;
  startStreamingAssistantMessage: () => string;
  appendAssistantContent: (delta: string) => string;
  finalizeStreamingMessage: (extraContent?: string, extraThinking?: string) => void;
  clearFinalizingStreamingMessageId: () => void;
}

// ==================== App ====================

interface AppFields {
  initializationStatus: InitializationStatus;
  initializationError: string | null;
  activeModal: ActiveModal;
  sessionSelectorData: SessionMetadata[] | undefined;
  modelEditorTarget: ModelConfig | null;
  todos: TodoItem[];
  awaitingSecondCtrlC: boolean;
  thinkingModeEnabled: boolean;
  subagentProgress: SubagentProgress | null;
}

interface AppActionFields {
  setInitializationStatus: (status: InitializationStatus) => void;
  setInitializationError: (error: string | null) => void;
  setActiveModal: (modal: ActiveModal) => void;
  showSessionSelector: (sessions?: SessionMetadata[]) => void;
  showModelEditWizard: (model: ModelConfig) => void;
  closeModal: () => void;
  setTodos: (todos: TodoItem[]) => void;
  updateTodo: (todo: TodoItem) => void;
  setAwaitingSecondCtrlC: (awaiting: boolean) => void;
  setThinkingModeEnabled: (enabled: boolean) => void;
  toggleThinkingMode: () => void;
  startSubagentProgress: (id: string, type: string, description: string) => void;
  updateSubagentTool: (toolName: string) => void;
  completeSubagentProgress: (success: boolean) => void;
}

// ==================== Config ====================

interface ConfigFields {
  config: RuntimeConfig | null;
}

interface ConfigActionFields {
  setConfig: (config: RuntimeConfig) => void;
  updateConfig: (partial: Partial<RuntimeConfig>) => void;
}

// ==================== Focus ====================

interface FocusFields {
  currentFocus: FocusId;
  previousFocus: FocusId | null;
}

interface FocusActionFields {
  setFocus: (id: FocusId) => void;
  restorePreviousFocus: () => void;
}

// ==================== Command ====================

interface CommandFields {
  isProcessing: boolean;
  abortController: AbortController | null;
  pendingCommands: PendingCommand[];
}

interface CommandActionFields {
  setProcessing: (isProcessing: boolean) => void;
  createAbortController: () => AbortController;
  getAbortController: () => AbortController | null;
  clearAbortController: (expectedController?: AbortController) => void;
  abort: () => void;
  enqueueCommand: (command: PendingCommand) => void;
  dequeueCommand: () => PendingCommand | undefined;
  clearQueue: () => void;
}

// ==================== Spec ====================

type SpecFields = Omit<SpecState, 'error' | 'isActive'> & {
  specIsActive: boolean;
  specError: string | null;
};

type SpecActionFields = Omit<SpecActions, 'setError' | 'reset'> & {
  setSpecError: (error: string | null) => void;
  resetSpec: () => void;
};

// ==================== Default State ====================

const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 200000,
};

export function getDefaultAppState(): Omit<
  AppState,
  | keyof SessionActionFields
  | keyof AppActionFields
  | keyof ConfigActionFields
  | keyof FocusActionFields
  | keyof CommandActionFields
  | keyof SpecActionFields
> {
  return {
    // Session
    sessionId: '',
    messages: [],
    isCompacting: false,
    currentCommand: null,
    error: null,
    isActive: true,
    tokenUsage: { ...initialTokenUsage },
    currentThinkingContent: null,
    thinkingExpanded: false,
    clearCount: 0,
    historyExpanded: false,
    expandedMessageCount: 100,
    currentStreamingMessageId: null,
    currentStreamingChunks: [],
    currentStreamingLines: [],
    currentStreamingTail: '',
    currentStreamingLineCount: 0,
    currentStreamingVersion: 0,
    finalizingStreamingMessageId: null,

    // App
    initializationStatus: 'idle',
    initializationError: null,
    activeModal: 'none',
    sessionSelectorData: undefined,
    modelEditorTarget: null,
    todos: [],
    awaitingSecondCtrlC: false,
    thinkingModeEnabled: false,
    subagentProgress: null,

    // Config
    config: null,

    // Focus
    currentFocus: 'main-input' as FocusId,
    previousFocus: null,

    // Command
    isProcessing: false,
    abortController: null,
    pendingCommands: [],

    // Spec
    currentSpec: null,
    specPath: null,
    specIsActive: false,
    steeringContext: null,
    recentSpecs: [],
    isLoading: false,
    specError: null,
    workspaceRoot: null,
  };
}
