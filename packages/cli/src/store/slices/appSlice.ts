/**
 * App Slice - 应用状态管理
 *
 * 职责：
 * - 初始化状态
 * - 模态框管理
 * - Todo 列表管理
 *
 * 注意：配置管理已迁移到独立的 Config Slice
 */

import type { StateCreator } from 'zustand';
import type { ModelConfig } from '../../config/types.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type {
  ActiveModal,
  AppSlice,
  AppState,
  BladeStore,
  InitializationStatus,
} from '../types.js';

/**
 * 初始应用状态
 */
const initialAppState: AppState = {
  initializationStatus: 'idle',
  initializationError: null,
  activeModal: 'none',
  sessionSelectorData: undefined,
  modelEditorTarget: null,
  todos: [],
  awaitingSecondCtrlC: false,
  thinkingModeEnabled: false, // Thinking 模式默认关闭
  subagentProgress: null, // 当前无 subagent 执行
};

/**
 * 创建 App Slice
 */
export const createAppSlice: StateCreator<BladeStore, [], [], AppSlice> = (set) => ({
  ...initialAppState,

  actions: {
    /**
     * 设置初始化状态
     */
    setInitializationStatus: (status: InitializationStatus) => {
      set((state) => ({
        app: { ...state.app, initializationStatus: status },
      }));
    },

    /**
     * 设置初始化错误
     */
    setInitializationError: (error: string | null) => {
      set((state) => ({
        app: { ...state.app, initializationError: error },
      }));
    },

    /**
     * 设置活动模态框
     */
    setActiveModal: (modal: ActiveModal) => {
      set((state) => ({
        app: { ...state.app, activeModal: modal },
      }));
    },

    /**
     * 显示会话选择器
     */
    showSessionSelector: (sessions?: SessionMetadata[]) => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'sessionSelector',
          sessionSelectorData: sessions,
        },
      }));
    },

    /**
     * 显示模型编辑向导
     */
    showModelEditWizard: (model: ModelConfig) => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'modelEditWizard',
          modelEditorTarget: model,
        },
      }));
    },

    /**
     * 关闭模态框
     */
    closeModal: () => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'none',
          sessionSelectorData: undefined,
          modelEditorTarget: null,
        },
      }));
    },

    /**
     * 设置 Todo 列表
     */
    setTodos: (todos: TodoItem[]) => {
      set((state) => ({
        app: { ...state.app, todos },
      }));
    },

    /**
     * 更新单个 Todo
     */
    updateTodo: (todo: TodoItem) => {
      set((state) => ({
        app: {
          ...state.app,
          todos: state.app.todos.map((t) => (t.id === todo.id ? todo : t)),
        },
      }));
    },

    /**
     * 设置是否等待第二次 Ctrl+C 退出
     */
    setAwaitingSecondCtrlC: (awaiting: boolean) => {
      set((state) => ({
        app: { ...state.app, awaitingSecondCtrlC: awaiting },
      }));
    },

    // ==================== Thinking 模式相关 actions ====================

    /**
     * 设置 Thinking 模式开关状态
     */
    setThinkingModeEnabled: (enabled: boolean) => {
      set((state) => ({
        app: { ...state.app, thinkingModeEnabled: enabled },
      }));
    },

    /**
     * 切换 Thinking 模式开关
     */
    toggleThinkingMode: () => {
      set((state) => ({
        app: { ...state.app, thinkingModeEnabled: !state.app.thinkingModeEnabled },
      }));
    },

    // ==================== Subagent 进度相关 actions ====================

    /**
     * 开始 subagent 执行进度
     */
    startSubagentProgress: (id: string, type: string, description: string) => {
      set((state) => ({
        app: {
          ...state.app,
          subagentProgress: {
            id,
            type,
            description,
            status: 'running',
            startTime: Date.now(),
          },
        },
      }));
    },

    /**
     * 更新当前执行的工具名称
     */
    updateSubagentTool: (toolName: string) => {
      set((state) => {
        if (!state.app.subagentProgress) return state;
        return {
          app: {
            ...state.app,
            subagentProgress: {
              ...state.app.subagentProgress,
              currentTool: toolName,
            },
          },
        };
      });
    },

    /**
     * 完成 subagent 执行
     */
    completeSubagentProgress: (success: boolean) => {
      set((state) => {
        if (!state.app.subagentProgress) return state;
        return {
          app: {
            ...state.app,
            subagentProgress: {
              ...state.app.subagentProgress,
              status: success ? 'completed' : 'failed',
              currentTool: undefined,
            },
          },
        };
      });
      setTimeout(() => {
        set((state) => ({
          app: { ...state.app, subagentProgress: null },
        }));
      }, 1500);
    },
  },
});
