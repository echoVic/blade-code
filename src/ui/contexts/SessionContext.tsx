import React, { createContext, ReactNode, useContext, useReducer } from 'react';

/**
 * 会话消息
 */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

/**
 * 会话状态
 */
export interface SessionState {
  messages: SessionMessage[];
  isThinking: boolean;
  input: string;
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
  | { type: 'SET_THINKING'; payload: boolean }
  | { type: 'SET_COMMAND'; payload: string | null }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'RESET_SESSION' };

/**
 * 会话上下文类型
 */
export interface SessionContextType {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  clearMessages: () => void;
  resetSession: () => void;
}

// 创建上下文
const SessionContext = createContext<SessionContextType | undefined>(undefined);

// 初始状态
const initialState: SessionState = {
  messages: [],
  isThinking: false,
  input: '',
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
      return { ...state, input: action.payload };

    case 'SET_THINKING':
      return { ...state, isThinking: action.payload };

    case 'SET_COMMAND':
      return { ...state, currentCommand: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [], error: null };

    case 'RESET_SESSION':
      return { ...initialState, isActive: true };

    default:
      return state;
  }
}

/**
 * 会话上下文提供者
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  const addUserMessage = (content: string) => {
    const message: SessionMessage = {
      id: `user-${Date.now()}-${Math.random()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    dispatch({ type: 'ADD_MESSAGE', payload: message });
  };

  const addAssistantMessage = (content: string) => {
    const message: SessionMessage = {
      id: `assistant-${Date.now()}-${Math.random()}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    dispatch({ type: 'ADD_MESSAGE', payload: message });
  };

  const clearMessages = () => {
    dispatch({ type: 'CLEAR_MESSAGES' });
  };

  const resetSession = () => {
    dispatch({ type: 'RESET_SESSION' });
  };

  const value: SessionContextType = {
    state,
    dispatch,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    resetSession,
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
