/**
 * Blade Store 选择器
 *
 * 遵循强选择器约束准则：
 * - 每个选择器只订阅需要的状态片段
 * - 避免订阅整个 store
 * - 提供派生选择器减少重复计算
 * - 使用 useShallow 优化返回对象/数组的选择器
 */

import { useShallow } from 'zustand/react/shallow';
import type { ModelConfig } from '../../config/types.js';
import { useBladeStore } from '../index.js';
import { type ActiveModal, type FocusId, PermissionMode } from '../types.js';

// ==================== 常量空引用（避免不必要的重渲染）====================

const EMPTY_MODELS: ModelConfig[] = [];

// ==================== Session 选择器 ====================

/**
 * 获取 Session ID
 */
export const useSessionId = () => useBladeStore((state) => state.session.sessionId);

/**
 * 获取消息列表
 */
export const useMessages = () => useBladeStore((state) => state.session.messages);

/**
 * 获取思考状态
 */
export const useIsThinking = () => useBladeStore((state) => state.session.isThinking);

/**
 * 获取压缩状态
 */
export const useIsCompacting = () => useBladeStore((state) => state.session.isCompacting);

/**
 * 获取当前命令
 */
export const useCurrentCommand = () =>
  useBladeStore((state) => state.session.currentCommand);

/**
 * 获取 Session 错误
 */
export const useSessionError = () => useBladeStore((state) => state.session.error);

/**
 * 获取 Session 是否活跃
 */
export const useIsActive = () => useBladeStore((state) => state.session.isActive);

/**
 * 获取 Session Actions
 */
export const useSessionActions = () => useBladeStore((state) => state.session.actions);

/**
 * 获取 Token 使用量
 */
export const useTokenUsage = () => useBladeStore((state) => state.session.tokenUsage);

/**
 * 派生选择器：Context 剩余百分比
 */
export const useContextRemaining = () =>
  useBladeStore((state) => {
    const { inputTokens, maxContextTokens } = state.session.tokenUsage;
    if (maxContextTokens <= 0) return 100;
    const remaining = Math.max(0, 100 - (inputTokens / maxContextTokens) * 100);
    return Math.round(remaining);
  });

/**
 * 派生选择器：最后一条消息
 */
export const useLastMessage = () =>
  useBladeStore((state) => {
    const messages = state.session.messages;
    return messages.length > 0 ? messages[messages.length - 1] : null;
  });

/**
 * 派生选择器：消息数量
 */
export const useMessageCount = () =>
  useBladeStore((state) => state.session.messages.length);

/**
 * 组合选择器：完整 Session 状态（用于需要多个字段的组件）
 * 使用 useShallow 避免因返回新对象而导致的不必要重渲染
 */
export const useSessionState = () =>
  useBladeStore(
    useShallow((state) => ({
      sessionId: state.session.sessionId,
      messages: state.session.messages,
      isThinking: state.session.isThinking,
      currentCommand: state.session.currentCommand,
      error: state.session.error,
      isActive: state.session.isActive,
    }))
  );

// ==================== App 选择器 ====================

/**
 * 获取初始化状态
 */
export const useInitializationStatus = () =>
  useBladeStore((state) => state.app.initializationStatus);

/**
 * 获取初始化错误
 */
export const useInitializationError = () =>
  useBladeStore((state) => state.app.initializationError);

/**
 * 获取活动模态框
 */
export const useActiveModal = () => useBladeStore((state) => state.app.activeModal);

/**
 * 获取 Todos
 */
export const useTodos = () => useBladeStore((state) => state.app.todos);

/**
 * 获取模型编辑目标
 */
export const useModelEditorTarget = () =>
  useBladeStore((state) => state.app.modelEditorTarget);

/**
 * 获取会话选择器数据
 */
export const useSessionSelectorData = () =>
  useBladeStore((state) => state.app.sessionSelectorData);

/**
 * 获取是否等待第二次 Ctrl+C
 */
export const useAwaitingSecondCtrlC = () =>
  useBladeStore((state) => state.app.awaitingSecondCtrlC);

/**
 * 获取 App Actions
 */
export const useAppActions = () => useBladeStore((state) => state.app.actions);

/**
 * 派生选择器：是否准备就绪
 */
export const useIsReady = () =>
  useBladeStore((state) => state.app.initializationStatus === 'ready');

/**
 * 派生选择器：是否需要设置
 */
export const useNeedsSetup = () =>
  useBladeStore((state) => state.app.initializationStatus === 'needsSetup');

/**
 * 派生选择器：是否显示 Todo 面板
 */
export const useShowTodoPanel = () =>
  useBladeStore((state) => state.app.todos.length > 0);

/**
 * 派生选择器：Todo 统计
 * 使用 useShallow 避免因返回新对象而导致的不必要重渲染
 */
export const useTodoStats = () =>
  useBladeStore(
    useShallow((state) => {
      const todos = state.app.todos;
      return {
        total: todos.length,
        completed: todos.filter((t) => t.status === 'completed').length,
        inProgress: todos.filter((t) => t.status === 'in_progress').length,
        pending: todos.filter((t) => t.status === 'pending').length,
      };
    })
  );

/**
 * 组合选择器：完整 App 状态（用于需要多个字段的组件）
 * 使用 useShallow 避免因返回新对象而导致的不必要重渲染
 */
export const useAppState = () =>
  useBladeStore(
    useShallow((state) => ({
      initializationStatus: state.app.initializationStatus,
      initializationError: state.app.initializationError,
      activeModal: state.app.activeModal,
      todos: state.app.todos,
    }))
  );

// ==================== Config 选择器 ====================

/**
 * 获取配置
 */
export const useConfig = () => useBladeStore((state) => state.config.config);

/**
 * 派生选择器：权限模式
 */
export const usePermissionMode = () =>
  useBladeStore(
    (state) => state.config.config?.permissionMode || PermissionMode.DEFAULT
  );

/**
 * 派生选择器：所有模型配置
 * 使用常量空数组避免不必要的重渲染
 */
export const useAllModels = () =>
  useBladeStore((state) => state.config.config?.models ?? EMPTY_MODELS);

/**
 * 派生选择器：当前模型配置
 */
export const useCurrentModel = () =>
  useBladeStore((state) => {
    const config = state.config.config;
    if (!config) return undefined;

    const currentModelId = config.currentModelId;
    const model = config.models.find((m) => m.id === currentModelId);
    return model ?? config.models[0];
  });

/**
 * 派生选择器：当前模型 ID
 */
export const useCurrentModelId = () =>
  useBladeStore((state) => state.config.config?.currentModelId);

/**
 * 获取 Config Actions
 */
export const useConfigActions = () => useBladeStore((state) => state.config.actions);

// ==================== Focus 选择器 ====================

/**
 * 获取当前焦点
 */
export const useCurrentFocus = () => useBladeStore((state) => state.focus.currentFocus);

/**
 * 获取上一个焦点
 */
export const usePreviousFocus = () =>
  useBladeStore((state) => state.focus.previousFocus);

/**
 * 获取 Focus Actions
 */
export const useFocusActions = () => useBladeStore((state) => state.focus.actions);

/**
 * 派生选择器：检查特定焦点是否激活
 */
export const useIsFocused = (id: FocusId) =>
  useBladeStore((state) => state.focus.currentFocus === id);

// ==================== Command 选择器 ====================

/**
 * 获取处理状态
 */
export const useIsProcessing = () =>
  useBladeStore((state) => state.command.isProcessing);

/**
 * 获取 AbortController
 */
export const useAbortController = () =>
  useBladeStore((state) => state.command.abortController);

/**
 * 获取 Command Actions
 */
export const useCommandActions = () => useBladeStore((state) => state.command.actions);

/**
 * 获取待处理命令队列
 */
export const usePendingCommands = () =>
  useBladeStore((state) => state.command.pendingCommands);

/**
 * 派生选择器：是否可以中止
 */
export const useCanAbort = () =>
  useBladeStore(
    (state) => state.command.isProcessing && state.command.abortController !== null
  );

// ==================== 跨 Slice 组合选择器 ====================

/**
 * 派生选择器：输入是否禁用
 *
 * 输入禁用条件：
 * - 正在思考 (isThinking)
 * - 未准备就绪
 * - 有活动模态框（除了 shortcuts）
 */
export const useIsInputDisabled = () =>
  useBladeStore((state) => {
    const isThinking = state.session.isThinking;
    const isReady = state.app.initializationStatus === 'ready';
    const hasModal =
      state.app.activeModal !== 'none' && state.app.activeModal !== 'shortcuts';
    return isThinking || !isReady || hasModal;
  });

/**
 * 派生选择器：是否有模态框打开
 */
export const useHasActiveModal = () =>
  useBladeStore((state) => state.app.activeModal !== 'none');

/**
 * 派生选择器：是否是特定模态框
 */
export const useIsModal = (modal: ActiveModal) =>
  useBladeStore((state) => state.app.activeModal === modal);

/**
 * 派生选择器：是否正在执行任务（思考或处理）
 */
export const useIsBusy = () =>
  useBladeStore((state) => state.session.isThinking || state.command.isProcessing);
