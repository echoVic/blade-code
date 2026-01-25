import { api, type Message, type Session, type StreamEvent } from '@/lib/api'
import { create } from 'zustand'
import { useConfigStore } from './ConfigStore'

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

interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  isTemporarySession: boolean
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
  error: string | null

  tokenUsage: TokenUsage
  currentThinkingContent: string | null
  thinkingExpanded: boolean
  todos: TodoItem[]
  subagentProgress: SubagentProgress | null
  currentToolBatch: ToolBatch | null
  toolBatchAggregationEnabled: boolean

  currentAbort: (() => void) | null

  loadSessions: () => Promise<void>
  createSession: (projectPath?: string) => Promise<Session>
  startTemporarySession: () => void
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortSession: () => Promise<void>

  handleEvent: (event: StreamEvent) => void
  clearError: () => void
  toggleThinkingExpanded: () => void
  setMaxContextTokens: (tokens: number, isDefault?: boolean) => void
  setToolBatchAggregation: (enabled: boolean) => void
}

const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 128000,
  isDefaultMaxTokens: true,
}

const TEMP_SESSION_ID = '__temp__'

const toolToBatchMap = new Map<string, string>()

const READ_ONLY_TOOLS = new Set([
  'Glob',
  'Grep',
  'Read',
  'LS',
  'SearchCodebase',
  'WebSearch',
  'WebFetch',
  'mcp_Fetch_fetch',
  'mcp_context7_resolve-library-id',
  'mcp_context7_query-docs',
  'mcp_GitHub_search_repositories',
  'mcp_GitHub_search_code',
  'mcp_GitHub_search_issues',
  'mcp_GitHub_search_users',
  'mcp_GitHub_get_file_contents',
  'mcp_GitHub_list_commits',
  'mcp_GitHub_list_issues',
  'mcp_GitHub_list_pull_requests',
  'mcp_GitHub_get_issue',
  'mcp_GitHub_get_pull_request',
  'mcp_GitHub_get_pull_request_files',
  'mcp_GitHub_get_pull_request_status',
  'mcp_GitHub_get_pull_request_comments',
  'mcp_GitHub_get_pull_request_reviews',
  'mcp_pencil_get_editor_state',
  'mcp_pencil_get_guidelines',
  'mcp_pencil_get_screenshot',
  'mcp_pencil_get_style_guide',
  'mcp_pencil_get_style_guide_tags',
  'mcp_pencil_get_variables',
  'mcp_pencil_snapshot_layout',
  'mcp_pencil_search_all_unique_properties',
  'mcp_pencil_batch_get',
  'mcp_Puppeteer_puppeteer_screenshot',
  'mcp_Sequential_Thinking_sequentialthinking',
  'CheckCommandStatus',
  'GetDiagnostics',
])

const isReadOnlyTool = (toolName: string): boolean => {
  if (READ_ONLY_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_get_')) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_list_')) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_search_')) return true
  return false
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  isTemporarySession: false,
  messages: [],
  isLoading: false,
  isStreaming: false,
  error: null,

  tokenUsage: { ...initialTokenUsage },
  currentThinkingContent: null,
  thinkingExpanded: false,
  todos: [],
  subagentProgress: null,
  currentToolBatch: null,
  toolBatchAggregationEnabled: true,

  currentAbort: null,

  loadSessions: async () => {
    set({ isLoading: true, error: null })
    try {
      const sessions = await api.listSessions()
      set({ sessions, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createSession: async (projectPath?: string) => {
    set({ isLoading: true, error: null })
    try {
      const session = await api.createSession(projectPath)
      set((state) => ({
        sessions: [...state.sessions, session],
        currentSessionId: session.sessionId,
        isTemporarySession: false,
        messages: [],
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
        currentThinkingContent: null,
        todos: [],
        subagentProgress: null,
      }))
      return session
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
      throw err
    }
  },

  startTemporarySession: () => {
    set({
      currentSessionId: TEMP_SESSION_ID,
      isTemporarySession: true,
      messages: [],
      tokenUsage: { ...initialTokenUsage },
      currentThinkingContent: null,
      todos: [],
      subagentProgress: null,
      error: null,
    })
  },

  selectSession: async (sessionId: string) => {
    toolToBatchMap.clear()
    set({ isLoading: true, error: null, currentSessionId: sessionId, isTemporarySession: false, currentToolBatch: null })
    try {
      const messages = await api.listMessages(sessionId)
      set({
        messages,
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
        currentThinkingContent: null,
        todos: [],
        subagentProgress: null,
      })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId)
      set((state) => ({
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
          currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
          messages: state.currentSessionId === sessionId ? [] : state.messages,
      }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  sendMessage: async (content: string) => {
    const { currentSessionId, isTemporarySession, handleEvent } = get()
    
    let sessionId = currentSessionId
    
    if (isTemporarySession || !currentSessionId || currentSessionId === TEMP_SESSION_ID) {
      try {
        const session = await api.createSession()
        set((state) => ({
          sessions: [...state.sessions, session],
          currentSessionId: session.sessionId,
          isTemporarySession: false,
        }))
        sessionId = session.sessionId
      } catch (err) {
        set({ error: (err as Error).message })
        return
      }
    }

    if (!sessionId || sessionId === TEMP_SESSION_ID) {
      set({ error: 'Failed to create session' })
      return
    }

    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    set((state) => ({
      messages: [...state.messages, userMessage],
      isStreaming: true,
      error: null,
    }))

    try {
      const { currentMode } = useConfigStore.getState()
      const { abort, done } = api.sendMessageStream(
        sessionId,
        content,
        currentMode,
        handleEvent
      )
      
      set({ currentAbort: abort })
      
      await done
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        set({ error: (err as Error).message })
      }
    } finally {
      set({ isStreaming: false, currentAbort: null })
    }
  },

  abortSession: async () => {
    const { currentSessionId, currentAbort } = get()
    
    if (currentAbort) {
      currentAbort()
      set({ currentAbort: null, isStreaming: false })
    }
    
    if (currentSessionId) {
      try {
        await api.abortSession(currentSessionId)
      } catch {
        // Ignore abort errors
      }
    }
  },

  handleEvent: (event: StreamEvent) => {
    const { currentSessionId } = get()
    const props = event.properties
    const eventSessionId = props.sessionId as string | undefined
    const now = Date.now()

    switch (event.type) {
      case 'session.created': {
        break
      }

      case 'session.status': {
        const status = props.status as string
        set((state) => ({
          sessions: state.sessions,
          isStreaming: eventSessionId === currentSessionId && status === 'running',
        }))
        break
      }

      case 'session.deleted': {
        set((state) => ({
          sessions: state.sessions.filter((s) => s.sessionId !== eventSessionId),
          currentSessionId: state.currentSessionId === eventSessionId ? null : state.currentSessionId,
          messages: state.currentSessionId === eventSessionId ? [] : state.messages,
        }))
        break
      }

      case 'message.created':
      case 'message.updated': {
        if (eventSessionId !== currentSessionId) break
        const messageId = props.messageId as string
        const role = props.role as Message['role']
        const content = (props.content as string) || ''
        if (!messageId) break
        const message: Message = {
          id: messageId,
          role,
          content,
          timestamp: Date.now(),
        }
        set((state) => {
          const existingIndex = state.messages.findIndex((m) => m.id === message.id)
          if (existingIndex >= 0) {
            const newMessages = [...state.messages]
            newMessages[existingIndex] = message
            return { messages: newMessages }
          }
          if (role === 'user') {
            const tempIndex = state.messages.findIndex(
              (m) => m.role === 'user' && m.id?.startsWith('temp-') && m.content === content
            )
            if (tempIndex >= 0) {
              const newMessages = [...state.messages]
              newMessages[tempIndex] = message
              return { messages: newMessages }
            }
          }
          return { messages: [...state.messages, message] }
        })
        break
      }

      case 'message.delta': {
        if (eventSessionId !== currentSessionId) break
        const messageId = props.messageId as string
        const delta = props.delta as string
        if (!delta) break
        set((state) => {
          const existingMsg = state.messages.find((m) => m.id === messageId)
          if (!existingMsg) {
            const newMsg: Message = {
              id: messageId,
              role: 'assistant',
              content: delta,
              timestamp: now,
            }
            return { messages: [...state.messages, newMsg], isStreaming: true }
          }
          const newMessages = state.messages.map((m) =>
            m.id === messageId ? { ...m, content: m.content + delta } : m
          )
          return { messages: newMessages, isStreaming: true }
        })
        break
      }

      case 'message.complete': {
        if (eventSessionId !== currentSessionId) break
        set({ currentToolBatch: null })
        break
      }

      case 'tool.start': {
        if (eventSessionId !== currentSessionId) break
        const toolCallId = props.toolCallId as string | undefined
        const toolName = props.toolName as string | undefined
        const args = props.arguments as string | undefined
        const toolKind = props.toolKind as string | undefined
        
        const { toolBatchAggregationEnabled, currentToolBatch } = get()
        const shouldAggregate = toolBatchAggregationEnabled && toolName && isReadOnlyTool(toolName)
        
        if (shouldAggregate) {
          const newTool: ToolCallItem = {
            toolCallId: toolCallId || `tool-${now}`,
            toolName: toolName || 'Unknown',
            arguments: args,
            toolKind,
            status: 'running',
            startTime: now,
          }
          
          const actualToolCallId = toolCallId || `tool-${now}`
          
          if (currentToolBatch) {
            toolToBatchMap.set(actualToolCallId, currentToolBatch.id)
            
            set((state) => ({
              currentToolBatch: state.currentToolBatch ? {
                ...state.currentToolBatch,
                tools: [...state.currentToolBatch.tools, newTool],
              } : null,
            }))
            
            set((state) => {
              const batchMsgId = `tool-batch-${state.currentToolBatch?.id}`
              const messages = state.messages.map((m) => {
                if (m.id === batchMsgId && m.metadata?.kind === 'tool_batch') {
                  return {
                    ...m,
                    metadata: {
                      ...m.metadata,
                      tools: state.currentToolBatch?.tools || [],
                    },
                  }
                }
                return m
              })
              return { messages }
            })
          } else {
            const batchId = `batch-${now}`
            toolToBatchMap.set(actualToolCallId, batchId)
            
            const newBatch: ToolBatch = {
              id: batchId,
              tools: [newTool],
              startTime: now,
              isComplete: false,
            }
            
            const batchMessage: Message = {
              id: `tool-batch-${batchId}`,
              role: 'assistant',
              content: '',
              timestamp: now,
              metadata: {
                kind: 'tool_batch',
                batchId,
                tools: [newTool],
                isComplete: false,
              },
            }
            
            set((state) => ({
              currentToolBatch: newBatch,
              messages: [...state.messages, batchMessage],
            }))
          }
        } else {
          if (currentToolBatch) {
            set({ currentToolBatch: null })
          }
          const messageId = toolCallId ? `tool-call-${toolCallId}` : `tool-call-${now}`
          const message: Message = {
            id: messageId,
            role: 'assistant',
            content: '',
            timestamp: now,
            metadata: {
              kind: 'tool_call',
              toolCallId,
              toolName,
              arguments: args,
              toolKind,
              status: 'running',
            },
          }
          set((state) => ({ messages: [...state.messages, message] }))
        }
        break
      }

      case 'tool.result': {
        if (eventSessionId !== currentSessionId) break
        const toolCallId = props.toolCallId as string | undefined
        const toolName = props.toolName as string | undefined
        const success = props.success as boolean | undefined
        const output = props.output as string | undefined
        const summary = props.summary as string | undefined
        const metadata = props.metadata as Record<string, unknown> | undefined
        
        const batchId = toolCallId ? toolToBatchMap.get(toolCallId) : undefined
        
        if (batchId) {
          set((state) => {
            const batchMsgId = `tool-batch-${batchId}`
            
            const messages = state.messages.map((m) => {
              if (m.id === batchMsgId && m.metadata?.kind === 'tool_batch') {
                const tools = (m.metadata.tools as ToolCallItem[]) || []
                const updatedTools = tools.map((tool): ToolCallItem => {
                  if (tool.toolCallId === toolCallId) {
                    return {
                      ...tool,
                      status: success ? 'success' : 'error',
                      summary,
                      output,
                    }
                  }
                  return tool
                })
                
                const allComplete = updatedTools.every((t) => t.status !== 'running')
                
                return {
                  ...m,
                  metadata: {
                    ...m.metadata,
                    tools: updatedTools,
                    isComplete: allComplete,
                  },
                }
              }
              return m
            })
            
            if (state.currentToolBatch?.id === batchId) {
              const updatedTools = state.currentToolBatch.tools.map((tool): ToolCallItem => {
                if (tool.toolCallId === toolCallId) {
                  return {
                    ...tool,
                    status: success ? 'success' : 'error',
                    summary,
                    output,
                  }
                }
                return tool
              })
              const allComplete = updatedTools.every((t) => t.status !== 'running')
              
              return {
                currentToolBatch: allComplete ? null : {
                  ...state.currentToolBatch,
                  tools: updatedTools,
                  isComplete: allComplete,
                },
                messages,
              }
            }
            
            return { messages }
          })
        } else {
          if (toolCallId) {
            set((state) => {
              const hasToolCall = state.messages.some(
                (m) => m.metadata?.kind === 'tool_call' && m.metadata.toolCallId === toolCallId
              )
              
              if (hasToolCall) {
                const messages = state.messages.map((m) => {
                  if (m.metadata?.kind === 'tool_call' && m.metadata.toolCallId === toolCallId) {
                    return {
                      ...m,
                      metadata: {
                        ...m.metadata,
                        status: success ? 'success' : 'error',
                        summary,
                        output,
                      },
                    }
                  }
                  return m
                })
                return { messages }
              }
              
              const resultMessage: Message = {
                id: `tool-result-${toolCallId}`,
                role: 'assistant',
                content: output || '',
                timestamp: now,
                metadata: {
                  kind: 'tool_result',
                  toolCallId,
                  toolName,
                  success,
                  summary,
                  output,
                  metadata,
                },
              }
              return { messages: [...state.messages, resultMessage] }
            })
          }
        }
        break
      }

      case 'thinking.delta': {
        if (eventSessionId !== currentSessionId) break
        const delta = props.delta as string
        set((state) => ({
          currentThinkingContent: (state.currentThinkingContent || '') + delta,
        }))
        break
      }

      case 'thinking.completed': {
        if (eventSessionId !== currentSessionId) break
        break
      }

      case 'token.usage': {
        if (eventSessionId !== currentSessionId) break
        const usage: Partial<TokenUsage> = {
          inputTokens: props.inputTokens as number | undefined,
          outputTokens: props.outputTokens as number | undefined,
          totalTokens: props.totalTokens as number | undefined,
          maxContextTokens: props.maxContextTokens as number | undefined,
        }
        set((state) => ({
          tokenUsage: { ...state.tokenUsage, ...usage },
        }))
        break
      }

      case 'todo.updated': {
        if (eventSessionId !== currentSessionId) break
        const todos = props.todos as TodoItem[]
        set({ todos })
        break
      }

      case 'subagent.started': {
        if (eventSessionId !== currentSessionId) break
        set({
          subagentProgress: {
            id: props.id as string,
            type: props.type as string,
            description: props.description as string,
            status: 'running',
            startTime: Date.now(),
          },
        })
        break
      }

      case 'subagent.tool': {
        if (eventSessionId !== currentSessionId) break
        set((state) => {
          if (!state.subagentProgress) return state
          return {
            subagentProgress: {
              ...state.subagentProgress,
              currentTool: props.toolName as string,
            },
          }
        })
        break
      }

      case 'subagent.completed': {
        if (eventSessionId !== currentSessionId) break
        const success = props.success as boolean
        set((state) => {
          if (!state.subagentProgress) return state
          return {
            subagentProgress: {
              ...state.subagentProgress,
              status: success ? 'completed' : 'failed',
              currentTool: undefined,
            },
          }
        })
        setTimeout(() => {
          set({ subagentProgress: null })
        }, 1500)
        break
      }

      case 'session.completed':
      case 'session.error': {
        if (eventSessionId === currentSessionId) {
          set({ currentThinkingContent: null })
        }
        break
      }

      case 'permission.asked': {
        if (eventSessionId && eventSessionId !== currentSessionId) break
        const requestId = props.requestId as string
        const details = props.details as Record<string, unknown> | undefined
        const message: Message = {
          id: `permission-${requestId}`,
          role: 'assistant',
          content: '',
          timestamp: now,
          metadata: {
            kind: 'confirmation',
            requestId,
            details,
            status: 'pending',
          },
        }
        set((state) => ({ messages: [...state.messages, message] }))
        break
      }

      case 'permission.replied': {
        const requestId = props.requestId as string
        const approved = props.approved as boolean
        const answers = props.answers as Record<string, unknown> | undefined
        set((state) => {
          const messages = state.messages.map((m) => {
            if (m.metadata?.kind === 'confirmation' && m.metadata.requestId === requestId) {
              return {
                ...m,
                metadata: {
                  ...m.metadata,
                  status: approved ? 'approved' : 'denied',
                  answers,
                },
              }
            }
            return m
          })
          return { messages }
        })
        break
      }
    }
  },

  clearError: () => set({ error: null }),
  toggleThinkingExpanded: () => set((state) => ({ thinkingExpanded: !state.thinkingExpanded })),
  setMaxContextTokens: (tokens: number, isDefault = false) => set((state) => ({
    tokenUsage: { ...state.tokenUsage, maxContextTokens: tokens, isDefaultMaxTokens: isDefault },
  })),
  setToolBatchAggregation: (enabled: boolean) => set({ toolBatchAggregationEnabled: enabled }),
}))
