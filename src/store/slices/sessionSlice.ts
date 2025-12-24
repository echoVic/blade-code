/**
 * Session Slice - 会话状态管理
 *
 * 职责：
 * - 会话 ID 管理
 * - 消息历史管理
 * - 错误状态
 *
 * 注意：isThinking 已合并到 commandSlice.isProcessing
 */

import { nanoid } from 'nanoid';
import type { StateCreator } from 'zustand';
import type {
  BladeStore,
  SessionMessage,
  SessionSlice,
  SessionState,
  TokenUsage,
  ToolMessageMetadata,
} from '../types.js';

/**
 * 初始 Token 使用量
 */
const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 200000, // 默认值，会被 Agent 更新
};

/**
 * 初始会话状态
 */
const initialSessionState: SessionState = {
  sessionId: nanoid(),
  messages: [],
  isCompacting: false,
  currentCommand: null,
  error: null,
  isActive: true,
  tokenUsage: { ...initialTokenUsage },
  currentThinkingContent: null,
  thinkingExpanded: false,
  clearCount: 0,
  // 历史消息折叠相关
  historyExpanded: false, // 默认折叠历史消息（只显示最近 N 条）
  expandedMessageCount: 30, // 默认显示最近 30 条消息完整内容
};

/**
 * 创建 Session Slice
 */
export const createSessionSlice: StateCreator<BladeStore, [], [], SessionSlice> = (
  set,
  get
) => ({
  ...initialSessionState,

  actions: {
    /**
     * 添加消息（通用方法）
     */
    addMessage: (message: SessionMessage) => {
      set((state) => ({
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          error: null, // 清除错误
        },
      }));
    },

    /**
     * 添加用户消息
     */
    addUserMessage: (content: string) => {
      const message: SessionMessage = {
        id: `user-${Date.now()}-${Math.random()}`,
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      get().session.actions.addMessage(message);
    },

    /**
     * 添加助手消息
     * @param content 消息内容
     * @param thinkingContent 可选的 thinking 内容（如 DeepSeek R1 的推理过程）
     */
    addAssistantMessage: (content: string, thinkingContent?: string) => {
      const message: SessionMessage = {
        id: `assistant-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        thinkingContent,
      };
      get().session.actions.addMessage(message);
    },

    /**
     * 添加工具消息
     */
    addToolMessage: (content: string, metadata?: ToolMessageMetadata) => {
      const message: SessionMessage = {
        id: `tool-${Date.now()}-${Math.random()}`,
        role: 'tool',
        content,
        timestamp: Date.now(),
        metadata,
      };
      get().session.actions.addMessage(message);
    },

    /**
     * 设置压缩状态
     */
    setCompacting: (isCompacting: boolean) => {
      set((state) => ({
        session: { ...state.session, isCompacting },
      }));
    },

    /**
     * 设置当前命令
     */
    setCommand: (command: string | null) => {
      set((state) => ({
        session: { ...state.session, currentCommand: command },
      }));
    },

    /**
     * 设置错误
     */
    setError: (error: string | null) => {
      set((state) => ({
        session: { ...state.session, error },
      }));
    },

    /**
     * 清除消息
     * 同时递增 clearCount 以强制 UI 的 Static 组件重新挂载
     */
    clearMessages: () => {
      set((state) => ({
        session: {
          ...state.session,
          messages: [],
          error: null,
          clearCount: state.session.clearCount + 1,
        },
      }));
    },

    /**
     * 重置会话（保持 sessionId 和 actions）
     */
    resetSession: () => {
      set((state) => ({
        session: {
          ...state.session, // 保留 actions
          ...initialSessionState, // 覆盖状态字段
          sessionId: state.session.sessionId, // 保持 sessionId
          isActive: true,
        },
      }));
    },

    /**
     * 恢复会话
     */
    restoreSession: (sessionId: string, messages: SessionMessage[]) => {
      set((state) => ({
        session: {
          ...state.session,
          sessionId,
          messages,
          error: null,
          isActive: true,
        },
      }));
    },

    /**
     * 更新 Token 使用量
     */
    updateTokenUsage: (usage: Partial<TokenUsage>) => {
      set((state) => ({
        session: {
          ...state.session,
          tokenUsage: {
            ...state.session.tokenUsage,
            ...usage,
          },
        },
      }));
    },

    /**
     * 重置 Token 使用量
     */
    resetTokenUsage: () => {
      set((state) => ({
        session: {
          ...state.session,
          tokenUsage: { ...initialTokenUsage },
        },
      }));
    },

    // ==================== Thinking 相关 actions ====================

    /**
     * 设置当前 thinking 内容（用于流式接收）
     */
    setCurrentThinkingContent: (content: string | null) => {
      set((state) => ({
        session: { ...state.session, currentThinkingContent: content },
      }));
    },

    /**
     * 追加 thinking 内容（用于流式接收增量）
     */
    appendThinkingContent: (delta: string) => {
      set((state) => ({
        session: {
          ...state.session,
          currentThinkingContent: (state.session.currentThinkingContent || '') + delta,
        },
      }));
    },

    /**
     * 设置 thinking 内容是否展开
     */
    setThinkingExpanded: (expanded: boolean) => {
      set((state) => ({
        session: { ...state.session, thinkingExpanded: expanded },
      }));
    },

    /**
     * 切换 thinking 内容展开/折叠状态
     */
    toggleThinkingExpanded: () => {
      set((state) => ({
        session: {
          ...state.session,
          thinkingExpanded: !state.session.thinkingExpanded,
        },
      }));
    },

    // ==================== 历史消息折叠相关 actions ====================

    /**
     * 设置历史消息是否全部展开
     */
    setHistoryExpanded: (expanded: boolean) => {
      set((state) => ({
        session: { ...state.session, historyExpanded: expanded },
      }));
    },

    /**
     * 切换历史消息展开/折叠状态
     */
    toggleHistoryExpanded: () => {
      set((state) => ({
        session: {
          ...state.session,
          historyExpanded: !state.session.historyExpanded,
        },
      }));
    },

    /**
     * 设置保持展开的最近消息数量
     */
    setExpandedMessageCount: (count: number) => {
      set((state) => ({
        session: { ...state.session, expandedMessageCount: count },
      }));
    },

    /**
     * 增加 clearCount（用于强制 Static 组件重新挂载）
     * 主要用于终端 resize 时刷新显示，避免重渲染问题
     */
    incrementClearCount: () => {
      set((state) => ({
        session: {
          ...state.session,
          clearCount: state.session.clearCount + 1,
        },
      }));
    },
  },
});
