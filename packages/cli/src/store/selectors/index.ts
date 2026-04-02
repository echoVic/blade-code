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
import { themeManager } from '../../ui/themes/ThemeManager.js';
import { useBladeStore } from '../index.js';
import { PermissionMode } from '../types.js';

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
 * 获取清屏计数器（用于强制 Static 组件重新挂载）
 */
export const useClearCount = () => useBladeStore((state) => state.session.clearCount);

/**
 * 获取压缩状态
 */
export const useIsCompacting = () =>
  useBladeStore((state) => state.session.isCompacting);

/**
 * 获取 Session Actions
 */
export const useSessionActions = () => useBladeStore((state) => state.session.actions);

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
 * 派生选择器：是否显示 Todo 面板
 */
export const useShowTodoPanel = () =>
  useBladeStore((state) => state.app.todos.length > 0);

// ==================== Config 选择器 ====================

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
 * 派生选择器：当前主题对象（纯读取，无副作用）
 * 订阅 Store 中的主题名称变化，并返回完整的 Theme 对象
 *
 * 注意：themeManager 的同步由 useThemeSync hook 在 App 层统一处理，
 * 此处只做纯读取，避免每个使用 useTheme 的组件在渲染时触发副作用。
 */
export const useTheme = () =>
  useBladeStore((state) => {
    // 纯读取，不再在选择器中调用 themeManager.setTheme()
    return themeManager.getTheme();
  });

/**
 * 获取当前 Store 中配置的主题名称
 * 用于 useThemeSync hook 对比和同步
 */
export const useThemeName = () =>
  useBladeStore((state) => state.config.config?.theme ?? 'default');

// ==================== Focus 选择器 ====================

/**
 * 获取当前焦点
 */
export const useCurrentFocus = () => useBladeStore((state) => state.focus.currentFocus);

/**
 * 获取 Focus Actions
 */
export const useFocusActions = () => useBladeStore((state) => state.focus.actions);

// ==================== Command 选择器 ====================

/**
 * 获取处理状态
 */
export const useIsProcessing = () =>
  useBladeStore((state) => state.command.isProcessing);

/**
 * 获取 Command Actions
 */
export const useCommandActions = () => useBladeStore((state) => state.command.actions);

/**
 * 获取待处理命令队列
 */
export const usePendingCommands = () =>
  useBladeStore((state) => state.command.pendingCommands);

// ==================== Thinking 模式选择器 ====================

/**
 * 获取 Thinking 模式是否启用
 */
export const useThinkingModeEnabled = () =>
  useBladeStore((state) => state.app.thinkingModeEnabled);

/**
 * 获取当前 Thinking 内容（流式接收中）
 */
export const useCurrentThinkingContent = () =>
  useBladeStore((state) => state.session.currentThinkingContent);

/**
 * 获取 Thinking 内容是否展开
 */
export const useThinkingExpanded = () =>
  useBladeStore((state) => state.session.thinkingExpanded);

// ==================== 流式消息选择器 ====================

/**
 * 获取当前流式消息 ID
 */
export const useCurrentStreamingMessageId = () =>
  useBladeStore((state) => state.session.currentStreamingMessageId);

/**
 * 🆕 获取当前流式消息缓冲（行/尾部/总行数/版本）
 */
export const useCurrentStreamingBuffer = (): {
  lines: string[];
  tail: string;
  lineCount: number;
  version: number;
} =>
  useBladeStore(
    useShallow((state) => ({
      lines: state.session.currentStreamingLines,
      tail: state.session.currentStreamingTail,
      lineCount: state.session.currentStreamingLineCount,
      version: state.session.currentStreamingVersion,
    }))
  );

/**
 * 获取正在从流式切换到最终渲染的消息 ID
 */
export const useFinalizingStreamingMessageId = () =>
  useBladeStore((state) => state.session.finalizingStreamingMessageId);

// ==================== 历史消息折叠选择器 ====================

/**
 * 获取历史消息是否全部展开
 */
export const useHistoryExpanded = () =>
  useBladeStore((state) => state.session.historyExpanded);

/**
 * 获取保持展开的最近消息数量
 */
export const useExpandedMessageCount = () =>
  useBladeStore((state) => state.session.expandedMessageCount);

/**
 * 派生选择器：Spec 阶段和进度
 * 用于状态栏显示
 */
export const useSpecProgress = () =>
  useBladeStore(
    useShallow((state) => {
      const spec = state.spec.currentSpec;
      if (!spec) {
        return { phase: null, completed: 0, total: 0 };
      }
      const tasks = spec.tasks ?? [];
      const completed = tasks.filter((t) => t.status === 'completed').length;
      return {
        phase: spec.phase,
        completed,
        total: tasks.length,
      };
    })
  );
