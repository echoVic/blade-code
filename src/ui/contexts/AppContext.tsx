import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useReducer,
} from 'react';
import type { RuntimeConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';

// 初始化状态类型
export type InitializationStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'needsSetup'
  | 'error';

// 应用状态类型定义
export interface AppState {
  config: RuntimeConfig | null; // 运行时配置（包含 CLI 参数）
  initializationStatus: InitializationStatus; // 初始化状态
  initializationError: string | null; // 初始化错误信息
  showThemeSelector: boolean; // 主题选择器显示状态
  showPermissionsManager: boolean; // 权限管理器显示状态
  showSessionSelector: boolean; // 会话选择器显示状态
  sessionSelectorData: unknown[] | null; // 会话选择器数据
  todos: TodoItem[]; // 任务列表
  showTodoPanel: boolean; // Todo 面板显示状态
  permissionMode: PermissionMode; // 权限模式
}

// Action类型
type AppAction =
  | { type: 'SET_CONFIG'; payload: RuntimeConfig }
  | { type: 'SET_INITIALIZATION_STATUS'; payload: InitializationStatus }
  | { type: 'SET_INITIALIZATION_ERROR'; payload: string | null }
  | { type: 'SHOW_THEME_SELECTOR' }
  | { type: 'HIDE_THEME_SELECTOR' }
  | { type: 'SHOW_PERMISSIONS_MANAGER' }
  | { type: 'HIDE_PERMISSIONS_MANAGER' }
  | { type: 'SHOW_SESSION_SELECTOR'; payload?: unknown[] }
  | { type: 'HIDE_SESSION_SELECTOR' }
  | { type: 'SET_TODOS'; payload: TodoItem[] }
  | { type: 'UPDATE_TODO'; payload: TodoItem }
  | { type: 'SHOW_TODO_PANEL' }
  | { type: 'HIDE_TODO_PANEL' }
  | { type: 'TOGGLE_TODO_PANEL' }
  | { type: 'SET_PERMISSION_MODE'; payload: PermissionMode };

// 默认状态
const defaultState: AppState = {
  config: null,
  initializationStatus: 'idle',
  initializationError: null,
  showThemeSelector: false,
  showPermissionsManager: false,
  showSessionSelector: false,
  sessionSelectorData: null,
  todos: [],
  showTodoPanel: true,
  permissionMode: PermissionMode.DEFAULT,
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

    case 'SHOW_THEME_SELECTOR':
      return { ...state, showThemeSelector: true };

    case 'HIDE_THEME_SELECTOR':
      return { ...state, showThemeSelector: false };

    case 'SHOW_PERMISSIONS_MANAGER':
      return { ...state, showPermissionsManager: true };

    case 'HIDE_PERMISSIONS_MANAGER':
      return { ...state, showPermissionsManager: false };

    case 'SHOW_SESSION_SELECTOR':
      return {
        ...state,
        showSessionSelector: true,
        sessionSelectorData: action.payload || null,
      };

    case 'HIDE_SESSION_SELECTOR':
      return {
        ...state,
        showSessionSelector: false,
        sessionSelectorData: null,
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

    case 'SHOW_TODO_PANEL':
      return { ...state, showTodoPanel: true };

    case 'HIDE_TODO_PANEL':
      return { ...state, showTodoPanel: false };

    case 'TOGGLE_TODO_PANEL':
      return { ...state, showTodoPanel: !state.showTodoPanel };

    case 'SET_PERMISSION_MODE':
      return { ...state, permissionMode: action.payload };

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

  showThemeSelector: () => ({
    type: 'SHOW_THEME_SELECTOR' as const,
  }),

  hideThemeSelector: () => ({
    type: 'HIDE_THEME_SELECTOR' as const,
  }),

  showPermissionsManager: () => ({
    type: 'SHOW_PERMISSIONS_MANAGER' as const,
  }),

  hidePermissionsManager: () => ({
    type: 'HIDE_PERMISSIONS_MANAGER' as const,
  }),

  showSessionSelector: (sessions?: unknown[]) => ({
    type: 'SHOW_SESSION_SELECTOR' as const,
    payload: sessions,
  }),

  hideSessionSelector: () => ({
    type: 'HIDE_SESSION_SELECTOR' as const,
  }),

  setTodos: (todos: TodoItem[]) => ({
    type: 'SET_TODOS' as const,
    payload: todos,
  }),

  updateTodo: (todo: TodoItem) => ({
    type: 'UPDATE_TODO' as const,
    payload: todo,
  }),

  showTodoPanel: () => ({
    type: 'SHOW_TODO_PANEL' as const,
  }),

  hideTodoPanel: () => ({
    type: 'HIDE_TODO_PANEL' as const,
  }),

  toggleTodoPanel: () => ({
    type: 'TOGGLE_TODO_PANEL' as const,
  }),

  setPermissionMode: (mode: PermissionMode) => ({
    type: 'SET_PERMISSION_MODE' as const,
    payload: mode,
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
    permissionMode: initialConfig?.permissionMode || defaultState.permissionMode,
  });

  const actions = AppActions;

  // 检查 API Key 并设置初始化状态
  useEffect(() => {
    if (!initialConfig) {
      dispatch(AppActions.setInitializationStatus('error'));
      dispatch(AppActions.setInitializationError('RuntimeConfig 未初始化'));
      return;
    }

    // 检查 API Key
    if (!initialConfig.apiKey || initialConfig.apiKey.trim() === '') {
      if (initialConfig.debug) {
        console.log('[Debug] 未检测到 API Key，进入设置向导');
      }
      dispatch(AppActions.setInitializationStatus('needsSetup'));
      return;
    }

    if (initialConfig.debug) {
      console.log('[Debug] API Key 检查通过，准备就绪');
    }
    dispatch(AppActions.setInitializationStatus('ready'));
  }, [initialConfig]);

  return (
    <AppContext.Provider value={{ state, dispatch, actions }}>
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
    showTodoPanel: state.showTodoPanel,
    setTodos: actions.setTodos,
    updateTodo: actions.updateTodo,
    toggleTodoPanel: actions.toggleTodoPanel,
  };
};
