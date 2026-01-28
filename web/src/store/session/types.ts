import type { Message, PermissionMode, Session, StreamEvent } from '@/services'
import type { StateCreator } from 'zustand'

export type { Message, PermissionMode, Session, StreamEvent }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  maxContextTokens: number
  isDefaultMaxTokens: boolean
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export interface SubagentProgress {
  id: string
  type: string
  description: string
  status: 'running' | 'completed' | 'failed'
  currentTool?: string
  startTime: number
}

export interface ToolCallItem {
  toolCallId: string
  toolName: string
  arguments?: string
  toolKind?: string
  status: 'running' | 'success' | 'error'
  summary?: string
  output?: string
  startTime: number
}

export interface ToolBatch {
  id: string
  tools: ToolCallItem[]
  startTime: number
  isComplete: boolean
}

export interface SessionSlice {
  sessions: Session[]
  currentSessionId: string | null
  isTemporarySession: boolean
  isLoading: boolean
  error: string | null

  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  removeSession: (sessionId: string) => void
  setCurrentSession: (sessionId: string | null) => void
  setTemporarySession: (isTemp: boolean) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  startTemporarySession: () => void
  clearError: () => void
  loadSessions: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortSession: () => Promise<void>
}

export interface MessageSlice {
  messages: Message[]

  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
  appendDelta: (id: string, delta: string) => void
  replaceTemp: (content: string, message: Message) => void
}

export interface StreamingSlice {
  isStreaming: boolean
  currentRunId: string | null
  eventUnsubscribe: (() => void) | null

  setStreaming: (streaming: boolean) => void
  setRunId: (runId: string | null) => void
  subscribeToEvents: (sessionId: string) => void
  unsubscribeFromEvents: () => void
  handleEvent: (event: StreamEvent) => void
}

export interface ToolSlice {
  currentToolBatch: ToolBatch | null
  toolBatchAggregationEnabled: boolean

  handleToolStart: (props: ToolStartProps) => void
  handleToolResult: (props: ToolResultProps) => void
  setToolBatchAggregation: (enabled: boolean) => void
  clearToolBatch: () => void
}

export interface UiSlice {
  tokenUsage: TokenUsage
  currentThinkingContent: string | null
  thinkingExpanded: boolean
  todos: TodoItem[]
  subagentProgress: SubagentProgress | null

  updateTokenUsage: (usage: Partial<TokenUsage>) => void
  appendThinking: (delta: string) => void
  clearThinking: () => void
  toggleThinkingExpanded: () => void
  setTodos: (todos: TodoItem[]) => void
  setSubagentProgress: (progress: SubagentProgress | null) => void
  setMaxContextTokens: (tokens: number, isDefault?: boolean) => void
}

export type SessionStoreState = SessionSlice & MessageSlice & StreamingSlice & ToolSlice & UiSlice

export type SliceCreator<T> = StateCreator<SessionStoreState, [], [], T>

export interface ToolStartProps {
  toolCallId?: string
  toolName?: string
  arguments?: string
  toolKind?: string
}

export interface ToolResultProps {
  toolCallId?: string
  toolName?: string
  success?: boolean
  output?: string
  summary?: string
  metadata?: Record<string, unknown>
}
