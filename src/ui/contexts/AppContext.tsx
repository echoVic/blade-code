import { SessionMetadata } from '@/services/SessionService.js';
import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import type { ModelConfig, RuntimeConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';

// 初始化状态类型
export type InitializationStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'needsSetup'
  | 'error';

// 模态框类型
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

// 应用状态类型定义
export interface AppState {
  config: RuntimeConfig | null; // 运行时配置（包含 CLI 参数）
  initializationStatus: InitializationStatus; // 初始化状态
  initializationError: string | null; // 初始化错误信息
  activeModal: ActiveModal; // 当前活跃的模态框
  sessionSelectorData: SessionMetadata[] | undefined; // 会话选择器数据
  modelEditorTarget: ModelConfig | null; // 正在编辑的模型
  todos: TodoItem[]; // 任务列表
}

// Action类型
type AppAction =
  | { type: 'SET_CONFIG'; payload: RuntimeConfig }
  | { type: 'SET_INITIALIZATION_STATUS'; payload: InitializationStatus }
  | { type: 'SET_INITIALIZATION_ERROR'; payload: string | null }
  | { type: 'SET_ACTIVE_MODAL'; payload: ActiveModal }
  | { type: 'SHOW_SESSION_SELECTOR'; payload?: SessionMetadata[] }
  | { type: 'SHOW_MODEL_EDIT_WIZARD'; payload: ModelConfig }
  | { type: 'CLOSE_MODAL' }
  | { type: 'SET_TODOS'; payload: TodoItem[] }
  | { type: 'UPDATE_TODO'; payload: TodoItem };

// 默认状态
const defaultState: AppState = {
  config: null,
  initializationStatus: 'idle',
  initializationError: null,
  activeModal: 'none',
  sessionSelectorData: undefined,
  modelEditorTarget: null,
  todos: [],
};

// 状态reducer
function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONFIG':
      return { ...state, config: action.payload };

    case 'SET_INITIALIZATION_STATUS':
      return { ...state, initializationStatus: action.payload };

    case 'SET_INITIALIZATION_ERROR':
      return { ...state, initializationError: action.payload };

    case 'SET_ACTIVE_MODAL':
      return { ...state, activeModal: action.payload };

    case 'SHOW_SESSION_SELECTOR':
      return {
        ...state,
        activeModal: 'sessionSelector',
        sessionSelectorData: action.payload || undefined,
      };

    case 'SHOW_MODEL_EDIT_WIZARD':
      return {
        ...state,
        activeModal: 'modelEditWizard',
        modelEditorTarget: action.payload,
      };

    case 'CLOSE_MODAL':
      return {
        ...state,
        activeModal: 'none',
        sessionSelectorData: undefined,
        modelEditorTarget: null,
      };

    case 'SET_TODOS':
      return { ...state, todos: action.payload };

    case 'UPDATE_TODO':
      return {
        ...state,
        todos: state.todos.map((todo) =>
          todo.id === action.payload.id ? action.payload : todo
        ),
      };

    default:
      return state;
  }
}

// Context
const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  actions: AppActions;
} | null>(null);

// Action creators
export const AppActions = {
  setConfig: (config: RuntimeConfig) => ({
    type: 'SET_CONFIG' as const,
    payload: config,
  }),

  setInitializationStatus: (status: InitializationStatus) => ({
    type: 'SET_INITIALIZATION_STATUS' as const,
    payload: status,
  }),

  setInitializationError: (error: string | null) => ({
    type: 'SET_INITIALIZATION_ERROR' as const,
    payload: error,
  }),

  setActiveModal: (modal: ActiveModal) => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: modal,
  }),

  showThemeSelector: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'themeSelector' as ActiveModal,
  }),

  showPermissionsManager: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'permissionsManager' as ActiveModal,
  }),

  showSessionSelector: (sessions?: SessionMetadata[]) => ({
    type: 'SHOW_SESSION_SELECTOR' as const,
    payload: sessions,
  }),

  showShortcuts: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'shortcuts' as ActiveModal,
  }),

  showModelSelector: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'modelSelector' as ActiveModal,
  }),

  showModelAddWizard: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'modelAddWizard' as ActiveModal,
  }),

  showModelEditWizard: (model: ModelConfig) => ({
    type: 'SHOW_MODEL_EDIT_WIZARD' as const,
    payload: model,
  }),

  showAgentsManager: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'agentsManager' as ActiveModal,
  }),

  showAgentCreationWizard: () => ({
    type: 'SET_ACTIVE_MODAL' as const,
    payload: 'agentCreationWizard' as ActiveModal,
  }),

  closeModal: () => ({
    type: 'CLOSE_MODAL' as const,
  }),

  setTodos: (todos: TodoItem[]) => ({
    type: 'SET_TODOS' as const,
    payload: todos,
  }),

  updateTodo: (todo: TodoItem) => ({
    type: 'UPDATE_TODO' as const,
    payload: todo,
  }),

};

type AppActions = typeof AppActions;

// Provider组件
export const AppProvider: React.FC<{
  children: ReactNode;
  initialConfig?: RuntimeConfig;
}> = ({ children, initialConfig }) => {
  const [state, dispatch] = useReducer(appReducer, {
    ...defaultState,
    config: initialConfig || null,
  });

  const actions = AppActions;

  // 检查 API Key 并设置初始化状态
  useEffect(() => {
    if (!initialConfig) {
      dispatch(AppActions.setInitializationStatus('error'));
      dispatch(AppActions.setInitializationError('RuntimeConfig 未初始化'));
      return;
    }

    // 检查是否有模型配置
    if (!initialConfig.models || initialConfig.models.length === 0) {
      if (initialConfig.debug) {
        console.log('[Debug] 未检测到模型配置，进入设置向导');
      }
      dispatch(AppActions.setInitializationStatus('needsSetup'));
      return;
    }

    if (initialConfig.debug) {
      console.log('[Debug] 模型配置检查通过，准备就绪');
    }
    dispatch(AppActions.setInitializationStatus('ready'));
  }, [initialConfig]);

  const value = useMemo(
    () => ({ state, dispatch, actions }),
    [state, dispatch, actions]
  );

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

// Hook
export const useAppState = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppState must be used within an AppProvider');
  }
  return context;
};

// 选择器hooks
export const useAppConfig = () => {
  const { state, actions } = useAppState();
  return {
    config: state.config,
    setConfig: actions.setConfig,
  };
};

export const useTodos = () => {
  const { state, actions } = useAppState();
  return {
    todos: state.todos,
    showTodoPanel: state.todos.length > 0,
    setTodos: actions.setTodos,
    updateTodo: actions.updateTodo,
  };
};

/**
 * 权限模式选择器 Hook
 * 从 RuntimeConfig 中读取 permissionMode，避免状态重复
 */
export const usePermissionMode = () => {
  const { state } = useAppState();
  return state.config?.permissionMode || PermissionMode.DEFAULT;
};
