import { nanoid } from 'nanoid';
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useReducer,
} from 'react';
import { createLogger, LogCategory } from '../../logging/Logger.js';

// 创建 SessionContext 专用 Logger
const logger = createLogger(LogCategory.UI);

/**
 * 消息角色类型
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 工具消息元数据
 */
export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete'; // 控制前缀样式
  summary?: string; // 简洁摘要（如 "Wrote 2 lines to hello.ts"）
  detail?: string; // 详细内容（可选，如完整的文件预览、diff 等）
  params?: Record<string, unknown>; // 工具参数（用于显示调用信息）
}

/**
 * 会话消息
 */
export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, any> | ToolMessageMetadata;
}

/**
 * 会话状态
 */
export interface SessionState {
  sessionId: string; // 全局唯一会话 ID
  messages: SessionMessage[];
  isThinking: boolean;
  input: string;
  cursorPosition: number; // 光标位置（字符数）
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;
}

/**
 * 会话操作
 */
export type SessionAction =
  | { type: 'ADD_MESSAGE'; payload: SessionMessage }
  | { type: 'SET_INPUT'; payload: string }
  | { type: 'SET_CURSOR_POSITION'; payload: number }
  | { type: 'SET_THINKING'; payload: boolean }
  | { type: 'SET_COMMAND'; payload: string | null }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'RESET_SESSION' }
  | {
      type: 'RESTORE_SESSION';
      payload: { sessionId: string; messages: SessionMessage[] };
    };

/**
 * 会话上下文类型
 */
export interface SessionContextType {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  addToolMessage: (content: string, metadata?: ToolMessageMetadata) => void;
  clearMessages: () => void;
  resetSession: () => void;
  restoreSession: (sessionId: string, messages: SessionMessage[]) => void;
}

// 创建上下文
const SessionContext = createContext<SessionContextType | undefined>(undefined);

// 初始状态
const initialState: SessionState = {
  sessionId: nanoid(),
  messages: [],
  isThinking: false,
  input: '',
  cursorPosition: 0,
  currentCommand: null,
  error: null,
  isActive: true,
};

// Reducer 函数
function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [...state.messages, action.payload],
        error: null, // 清除错误当有新消息时
      };

    case 'SET_INPUT':
      return {
        ...state,
        input: action.payload,
        // 输入改变时,光标默认移动到末尾
        cursorPosition: action.payload.length,
      };

    case 'SET_CURSOR_POSITION':
      return { ...state, cursorPosition: action.payload };

    case 'SET_THINKING':
      return { ...state, isThinking: action.payload };

    case 'SET_COMMAND':
      return { ...state, currentCommand: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [], error: null };

    case 'RESET_SESSION':
      return {
        ...initialState,
        sessionId: state.sessionId, // 保持 sessionId 不变
        isActive: true,
      };

    case 'RESTORE_SESSION':
      return {
        ...state,
        sessionId: action.payload.sessionId,
        messages: action.payload.messages,
        error: null,
        isActive: true,
      };

    default:
      return state;
  }
}

/**
 * 会话上下文提供者
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  const addUserMessage = useCallback((content: string) => {
    logger.debug('[DIAG] addUserMessage called:', {
      contentLength: content.length,
      contentPreview: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
    });
    const message: SessionMessage = {
      id: `user-${Date.now()}-${Math.random()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    dispatch({ type: 'ADD_MESSAGE', payload: message });
    logger.debug('[DIAG] User message dispatched:', { messageId: message.id });
  }, []);

  const addAssistantMessage = useCallback((content: string) => {
    const message: SessionMessage = {
      id: `assistant-${Date.now()}-${Math.random()}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    dispatch({ type: 'ADD_MESSAGE', payload: message });
  }, []);

  const addToolMessage = useCallback(
    (content: string, metadata?: ToolMessageMetadata) => {
      const message: SessionMessage = {
        id: `tool-${Date.now()}-${Math.random()}`,
        role: 'tool',
        content,
        timestamp: Date.now(),
        metadata,
      };
      dispatch({ type: 'ADD_MESSAGE', payload: message });
    },
    []
  );

  const clearMessages = useCallback(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
  }, []);

  const resetSession = useCallback(() => {
    dispatch({ type: 'RESET_SESSION' });
  }, []);

  const restoreSession = useCallback(
    (sessionId: string, messages: SessionMessage[]) => {
      dispatch({ type: 'RESTORE_SESSION', payload: { sessionId, messages } });
    },
    []
  );

  const value: SessionContextType = {
    state,
    dispatch,
    addUserMessage,
    addAssistantMessage,
    addToolMessage,
    clearMessages,
    resetSession,
    restoreSession,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * 使用会话上下文的 Hook
 */
export function useSession(): SessionContextType {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
