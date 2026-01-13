/**
 * 全局状态管理
 */

import { create } from 'zustand';
import type { SessionInfo, ConfigInfo } from '../types/acp';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
}

interface AppState {
  // 会话列表
  sessions: SessionInfo[];
  currentSessionId: string | null;

  // 当前会话消息
  messages: ChatMessage[];

  // 配置信息
  config: ConfigInfo | null;

  // UI 状态
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;

  // Actions
  setSessions: (sessions: SessionInfo[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  updateLastMessage: (content: string) => void;
  setConfig: (config: ConfigInfo) => void;
  setIsLoading: (loading: boolean) => void;
  setIsStreaming: (streaming: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  // 初始状态
  sessions: [],
  currentSessionId: null,
  messages: [],
  config: null,
  isLoading: false,
  isStreaming: false,
  error: null,

  // Actions
  setSessions: (sessions) => set({ sessions }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateLastMessage: (content) =>
    set((state) => {
      const messages = [...state.messages];
      if (messages.length > 0) {
        messages[messages.length - 1] = {
          ...messages[messages.length - 1],
          content,
        };
      }
      return { messages };
    }),
  setConfig: (config) => set({ config }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setIsStreaming: (isStreaming) => set({ isStreaming }),
  setError: (error) => set({ error }),
  clearMessages: () => set({ messages: [] }),
}));
