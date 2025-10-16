import React, { createContext, ReactNode, useContext, useReducer } from 'react';
import type { BladeConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';

// 应用状态类型定义
export interface AppState {
  isInitialized: boolean;
  isLoading: boolean;
  currentCommand: string | null;
  selectedTool: string | null;
  notifications: Notification[];
  config: BladeConfig | null;
  userPreferences: UserPreferences;
  performance: PerformanceStats;
  error: AppError | null;
  showThemeSelector: boolean;
  showPermissionsManager: boolean;
  todos: TodoItem[];
  showTodoPanel: boolean;
  permissionMode: PermissionMode;
}

// 用户偏好设置
export interface UserPreferences {
  theme: string;
  language: string;
  autoSave: boolean;
  debugMode: boolean;
  telemetry: boolean;
  shortcuts: Record<string, string>;
  fontSize: number;
  showStatusBar: boolean;
  showNotifications: boolean;
}

// 通知类型
export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: number;
  duration?: number;
  actions?: NotificationAction[];
}

export interface NotificationAction {
  label: string;
  action: () => void;
  style?: 'primary' | 'secondary';
}

// 性能统计
export interface PerformanceStats {
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  render: {
    fps: number;
    renderTime: number;
  };
  cpu: {
    usage: number;
  };
  uptime: number;
}

// 应用错误
export interface AppError {
  id: string;
  type: 'config' | 'network' | 'permission' | 'system' | 'unknown';
  message: string;
  timestamp: number;
  stack?: string;
  details?: Record<string, any>;
}

// Action类型
type AppAction =
  | { type: 'SET_INITIALIZED'; payload: boolean }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_CURRENT_COMMAND'; payload: string | null }
  | { type: 'SET_SELECTED_TOOL'; payload: string | null }
  | { type: 'ADD_NOTIFICATION'; payload: Notification }
  | { type: 'REMOVE_NOTIFICATION'; payload: string }
  | { type: 'CLEAR_NOTIFICATIONS' }
  | { type: 'SET_CONFIG'; payload: BladeConfig }
  | { type: 'UPDATE_PREFERENCES'; payload: Partial<UserPreferences> }
  | { type: 'SET_PERFORMANCE_STATS'; payload: Partial<PerformanceStats> }
  | { type: 'SET_ERROR'; payload: AppError | null }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SHOW_THEME_SELECTOR' }
  | { type: 'HIDE_THEME_SELECTOR' }
  | { type: 'SHOW_PERMISSIONS_MANAGER' }
  | { type: 'HIDE_PERMISSIONS_MANAGER' }
  | { type: 'SET_TODOS'; payload: TodoItem[] }
  | { type: 'UPDATE_TODO'; payload: TodoItem }
  | { type: 'SHOW_TODO_PANEL' }
  | { type: 'HIDE_TODO_PANEL' }
  | { type: 'TOGGLE_TODO_PANEL' }
  | { type: 'SET_PERMISSION_MODE'; payload: PermissionMode };

// 默认状态
const defaultState: AppState = {
  isInitialized: false,
  isLoading: false,
  currentCommand: null,
  selectedTool: null,
  notifications: [],
  config: null,
  userPreferences: {
    theme: 'default',
    language: 'zh-CN',
    autoSave: true,
    debugMode: false,
    telemetry: true,
    shortcuts: {},
    fontSize: 14,
    showStatusBar: true,
    showNotifications: true,
  },
  performance: {
    memory: {
      used: 0,
      total: 0,
      percentage: 0,
    },
    render: {
      fps: 60,
      renderTime: 16,
    },
    cpu: {
      usage: 0,
    },
    uptime: 0,
  },
  error: null,
  showThemeSelector: false,
  showPermissionsManager: false,
  todos: [],
  showTodoPanel: true,
  permissionMode: PermissionMode.DEFAULT,
};

// 状态reducer
function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_INITIALIZED':
      return { ...state, isInitialized: action.payload };

    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    case 'SET_CURRENT_COMMAND':
      return { ...state, currentCommand: action.payload };

    case 'SET_SELECTED_TOOL':
      return { ...state, selectedTool: action.payload };

    case 'ADD_NOTIFICATION':
      return {
        ...state,
        notifications: [...state.notifications, action.payload],
      };

    case 'REMOVE_NOTIFICATION':
      return {
        ...state,
        notifications: state.notifications.filter((n) => n.id !== action.payload),
      };

    case 'CLEAR_NOTIFICATIONS':
      return { ...state, notifications: [] };

    case 'SET_CONFIG':
      return { ...state, config: action.payload };

    case 'UPDATE_PREFERENCES':
      return {
        ...state,
        userPreferences: { ...state.userPreferences, ...action.payload },
      };

    case 'SET_PERFORMANCE_STATS':
      return {
        ...state,
        performance: { ...state.performance, ...action.payload },
      };

    case 'SET_ERROR':
      return { ...state, error: action.payload };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'SHOW_THEME_SELECTOR':
      return { ...state, showThemeSelector: true };

    case 'HIDE_THEME_SELECTOR':
      return { ...state, showThemeSelector: false };

    case 'SHOW_PERMISSIONS_MANAGER':
      return { ...state, showPermissionsManager: true };

    case 'HIDE_PERMISSIONS_MANAGER':
      return { ...state, showPermissionsManager: false };

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
  setInitialized: (isInitialized: boolean) => ({
    type: 'SET_INITIALIZED' as const,
    payload: isInitialized,
  }),

  setLoading: (isLoading: boolean) => ({
    type: 'SET_LOADING' as const,
    payload: isLoading,
  }),

  setCurrentCommand: (command: string | null) => ({
    type: 'SET_CURRENT_COMMAND' as const,
    payload: command,
  }),

  setSelectedTool: (tool: string | null) => ({
    type: 'SET_SELECTED_TOOL' as const,
    payload: tool,
  }),

  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => {
    const newNotification: Notification = {
      ...notification,
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };
    return { type: 'ADD_NOTIFICATION' as const, payload: newNotification };
  },

  removeNotification: (id: string) => ({
    type: 'REMOVE_NOTIFICATION' as const,
    payload: id,
  }),

  clearNotifications: () => ({
    type: 'CLEAR_NOTIFICATIONS' as const,
  }),

  setConfig: (config: BladeConfig) => ({
    type: 'SET_CONFIG' as const,
    payload: config,
  }),

  updatePreferences: (preferences: Partial<UserPreferences>) => ({
    type: 'UPDATE_PREFERENCES' as const,
    payload: preferences,
  }),

  setPerformanceStats: (stats: Partial<PerformanceStats>) => ({
    type: 'SET_PERFORMANCE_STATS' as const,
    payload: stats,
  }),

  setError: (error: AppError) => ({
    type: 'SET_ERROR' as const,
    payload: error,
  }),

  clearError: () => ({
    type: 'CLEAR_ERROR' as const,
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
export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(appReducer, defaultState);

  const actions = AppActions;

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
export const useNotifications = () => {
  const { state, actions } = useAppState();
  return {
    notifications: state.notifications,
    addNotification: actions.addNotification,
    removeNotification: actions.removeNotification,
    clearNotifications: actions.clearNotifications,
  };
};

export const useUserPreferences = () => {
  const { state, actions } = useAppState();
  return {
    preferences: state.userPreferences,
    updatePreferences: actions.updatePreferences,
  };
};

export const usePerformance = () => {
  const { state, actions } = useAppState();
  return {
    performance: state.performance,
    updatePerformance: actions.setPerformanceStats,
  };
};

export const useAppConfig = () => {
  const { state, actions } = useAppState();
  return {
    config: state.config,
    setConfig: actions.setConfig,
  };
};

export const useAppError = () => {
  const { state, actions } = useAppState();
  return {
    error: state.error,
    setError: actions.setError,
    clearError: actions.clearError,
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
