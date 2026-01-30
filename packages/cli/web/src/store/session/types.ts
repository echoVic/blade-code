import type { Message as BaseMessage, PermissionMode, Session, StreamEvent } from '@/services'
import type { StateCreator } from 'zustand'

export type { PermissionMode, Session, StreamEvent }

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

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  arguments?: string
  toolKind?: string
  status: 'running' | 'success' | 'error'
  summary?: string
  output?: string
  startTime: number
  metadata?: Record<string, unknown>
}

export interface AgentResponseContent {
  textBefore: string
  toolCalls: ToolCallInfo[]
  textAfter: string
  thinkingContent: string
  todos: TodoItem[]
  subagent: SubagentProgress | null
  confirmation: ConfirmationInfo | null
  question: QuestionInfo | null
}

export interface ConfirmationInfo {
  toolCallId: string
  toolName: string
  description: string
  diff?: string
  status: 'pending' | 'approved' | 'denied'
}

export interface QuestionInfo {
  toolCallId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
  status: 'pending' | 'answered'
  answers?: Record<string, string | string[]>
}

export interface Message extends Omit<BaseMessage, 'metadata'> {
  metadata?: Record<string, unknown>
  agentContent?: AgentResponseContent
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
  appendDelta: (id: string, delta: string, position: 'before' | 'after') => void
  appendToolCall: (id: string, toolCall: ToolCallInfo) => void
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCallInfo>) => void
  appendThinking: (id: string, delta: string) => void
  setConfirmation: (id: string, confirmation: ConfirmationInfo | null) => void
  setQuestion: (id: string, question: QuestionInfo | null) => void
  setSubagent: (id: string, subagent: SubagentProgress | null) => void
  setTodos: (id: string, todos: TodoItem[]) => void
  replaceTemp: (content: string, message: Message) => void
}

export interface StreamingSlice {
  isStreaming: boolean
  currentRunId: string | null
  eventUnsubscribe: (() => void) | null
  currentAssistantMessageId: string | null
  hasToolCalls: boolean

  setStreaming: (streaming: boolean) => void
  setRunId: (runId: string | null) => void
  subscribeToEvents: (sessionId: string) => void
  unsubscribeFromEvents: () => void
  handleEvent: (event: StreamEvent) => void
  setCurrentAssistantMessageId: (id: string | null) => void
  setHasToolCalls: (has: boolean) => void
  startAgentResponse: (messageId: string) => void
  endAgentResponse: () => void
}

export interface UiSlice {
  tokenUsage: TokenUsage

  updateTokenUsage: (usage: Partial<TokenUsage>) => void
  setMaxContextTokens: (tokens: number, isDefault?: boolean) => void
}

export type SessionStoreState = SessionSlice & MessageSlice & StreamingSlice & UiSlice

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
