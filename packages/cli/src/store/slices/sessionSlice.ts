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
import { clearAllMarkdownCache } from '../../ui/utils/markdownIncremental.js';
import type {
  BladeStore,
  SessionMessage,
  SessionSlice,
  SessionState,
  TokenUsage,
  ToolMessageMetadata,
} from '../types.js';

const STREAMING_LINE_BUFFER_LIMIT = 2000;

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
  expandedMessageCount: 100, // 默认显示最近 100 条消息完整内容
  // 流式消息相关
  currentStreamingMessageId: null, // 当前正在流式接收的助手消息 ID
  currentStreamingChunks: [], // 🆕 原始增量片段
  currentStreamingLines: [], // 🆕 已完成行缓冲
  currentStreamingTail: '', // 🆕 当前未完成的行片段
  currentStreamingLineCount: 0, // 🆕 已完成行总数
  currentStreamingVersion: 0, // 🆕 流式缓冲版本号
  finalizingStreamingMessageId: null, // 流式转最终渲染中的消息 ID
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
     * 添加助手消息并同时清空 thinking 内容（原子操作）
     * 用于流式接收完成后，避免两次 state 更新导致的闪烁
     *
     * @param content 消息内容
     */
    addAssistantMessageAndClearThinking: (content: string) => {
      const currentThinking = get().session.currentThinkingContent;
      const message: SessionMessage = {
        id: `assistant-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        thinkingContent: currentThinking || undefined,
      };
      // 单次 set 调用：同时添加消息和清空 thinking
      set((state) => ({
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          currentThinkingContent: null,
          error: null,
        },
      }));
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
      clearAllMarkdownCache();
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
      clearAllMarkdownCache();
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
      clearAllMarkdownCache();
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
      if (get().session.currentThinkingContent === content) {
        return;
      }
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

    // ==================== 流式消息相关 actions ====================

    /**
     * 开始新的流式助手消息
     * 创建一个空内容的助手消息，后续通过 appendAssistantContent 增量填充
     * @returns 消息 ID
     */
    startStreamingAssistantMessage: () => {
      const messageId = `assistant-${Date.now()}-${Math.random()}`;
      const message: SessionMessage = {
        id: messageId,
        role: 'assistant',
        content: '', // 空内容，后续增量填充
        timestamp: Date.now(),
      };
      set((state) => ({
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          currentStreamingMessageId: messageId,
          currentStreamingChunks: [],
          currentStreamingLines: [],
          currentStreamingTail: '',
          currentStreamingLineCount: 0,
          currentStreamingVersion: 0,
          error: null,
        },
      }));
      return messageId;
    },

    /**
     * 追加内容到当前流式消息
     * 如果没有活动的流式消息，自动创建一个（支持流式输出）
     *
     * 简化设计：
     * - 只累积已完成行 + 当前行片段
     * - 不在流式过程中分割消息，保持消息完整性
     * - 渲染层（MessageArea）负责视窗化显示
     *
     * @param delta 增量文本
     */
    appendAssistantContent: (delta: string) => {
      const streamingId = get().session.currentStreamingMessageId;
      const nextStreamingId = streamingId ?? `assistant-${Date.now()}-${Math.random()}`;
      set((state) => {
        const normalizeLine = (line: string) =>
          line.endsWith('\r') ? line.slice(0, -1) : line;

        const currentChunks = streamingId ? state.session.currentStreamingChunks : [];
        const currentLines = streamingId ? state.session.currentStreamingLines : [];
        const currentTail = streamingId ? state.session.currentStreamingTail : '';
        const currentLineCount = streamingId
          ? state.session.currentStreamingLineCount
          : 0;
        const currentVersion = streamingId ? state.session.currentStreamingVersion : 0;

        const combined = currentTail + delta;
        const parts = combined.split('\n');
        const completedParts = parts.slice(0, -1).map(normalizeLine);
        const nextTail = normalizeLine(parts[parts.length - 1] ?? '');
        const nextChunks = [...currentChunks, delta];
        let nextLines = currentLines;
        if (completedParts.length > 0) {
          nextLines = [...currentLines, ...completedParts];
          if (nextLines.length > STREAMING_LINE_BUFFER_LIMIT) {
            const overflow = nextLines.length - STREAMING_LINE_BUFFER_LIMIT;
            nextLines = nextLines.slice(overflow);
          }
        }

        return {
          session: {
            ...state.session,
            currentStreamingMessageId: nextStreamingId,
            currentStreamingChunks: nextChunks,
            currentStreamingLines: nextLines,
            currentStreamingTail: nextTail,
            currentStreamingLineCount: currentLineCount + completedParts.length,
            currentStreamingVersion: currentVersion + 1,
            error: null,
          },
        };
      });
      return nextStreamingId;
    },

    /**
     * 完成当前流式消息
     * 将已完成行 + 尾部片段作为完整消息添加到 messages 数组，清理流式状态
     *
     * @param extraContent 可选的额外内容（缓冲区剩余），会追加到流式内容
     * @param extraThinking 可选的额外 thinking 内容（缓冲区剩余）
     */
    finalizeStreamingMessage: (extraContent?: string, extraThinking?: string) => {
      set((state) => {
        const streamingId = state.session.currentStreamingMessageId;
        const baseContent = state.session.currentStreamingChunks.join('');
        const streamingContent = baseContent + (extraContent || '');
        const thinkingContent =
          (state.session.currentThinkingContent || '') + (extraThinking || '');

        if (streamingContent.length > 0) {
          const finalMessage: SessionMessage = {
            id: streamingId || `assistant-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            content: streamingContent,
            timestamp: Date.now(),
            thinkingContent: thinkingContent || undefined,
          };

          return {
            session: {
              ...state.session,
              messages: [...state.session.messages, finalMessage],
              currentStreamingMessageId: null,
              currentStreamingChunks: [],
              currentStreamingLines: [],
              currentStreamingTail: '',
              currentStreamingLineCount: 0,
              currentStreamingVersion: 0,
              currentThinkingContent: null,
              finalizingStreamingMessageId: finalMessage.id,
            },
          };
        }

        return {
          session: {
            ...state.session,
            currentStreamingMessageId: null,
            currentStreamingChunks: [],
            currentStreamingLines: [],
            currentStreamingTail: '',
            currentStreamingLineCount: 0,
            currentStreamingVersion: 0,
            currentThinkingContent: null,
            finalizingStreamingMessageId: null,
          },
        };
      });
    },

    /**
     * 清理流式转最终渲染标记
     */
    clearFinalizingStreamingMessageId: () => {
      set((state) => ({
        session: { ...state.session, finalizingStreamingMessageId: null },
      }));
    },
  },
});
