import type {
  Message,
  MessageRole,
  PermissionMode,
  PermissionResponse,
  Session,
} from '@api/schemas'

export interface StreamEvent {
  type: string
  properties: Record<string, unknown>
}

export interface SendMessageResponse {
  runId: string
  status: string
}

const API_BASE = ''

const normalizeContent = (content: unknown): string => {
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part && typeof part === 'object' && 'type' in part && part.type === 'text')
      .map((part) => (part as { text?: string }).text || '')
      .join('\n')
    return textParts || JSON.stringify(content)
  }
  if (content == null) return ''
  if (typeof content === 'string') return content
  return JSON.stringify(content)
}

const generateDefaultTitle = (): string => {
  const now = new Date()
  const year = String(now.getFullYear()).slice(-2)
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `Session ${year}-${month}-${day} ${hours}:${minutes}`
}

export const sessionService = {
  listSessions: async (): Promise<Session[]> => {
    const res = await fetch(`${API_BASE}/sessions`)
    if (!res.ok) throw new Error('Failed to load sessions')
    return res.json()
  },

  createSession: async (projectPath?: string, title?: string): Promise<Session> => {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, title: title || generateDefaultTitle() }),
    })
    if (!res.ok) throw new Error('Failed to create session')
    return res.json()
  },

  deleteSession: async (sessionId: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('Failed to delete session')
  },

  updateSession: async (sessionId: string, title: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error('Failed to update session')
  },

  getMessages: async (sessionId: string): Promise<Message[]> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/message`)
    if (!res.ok) throw new Error('Failed to load messages')
    const result = await res.json()
    const now = Date.now()
    return result.map((m: Message, index: number) => {
      const content = normalizeContent(m.content)
      const metadata = m.role === 'tool'
        ? {
            kind: 'tool_result',
            toolCallId: m.tool_call_id,
            toolName: m.name,
            output: content,
          }
        : m.metadata
      return {
        id: m.id || `history-${index}-${now}`,
        role: m.role,
        content,
        timestamp: now,
        metadata,
        tool_call_id: m.tool_call_id,
        name: m.name,
        tool_calls: m.tool_calls,
        thinkingContent: m.thinkingContent,
      }
    })
  },

  sendMessage: async (
    sessionId: string,
    content: string,
    permissionMode?: PermissionMode
  ): Promise<SendMessageResponse> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, permissionMode }),
    })
    if (!res.ok) throw new Error('Failed to send message')
    return res.json()
  },

  abortSession: async (sessionId: string): Promise<void> => {
    await fetch(`${API_BASE}/sessions/${sessionId}/abort`, { method: 'POST' })
  },

  subscribeEvents: (
    sessionId: string,
    onEvent: (event: StreamEvent) => void,
    options?: { maxRetries?: number; onConnectionChange?: (connected: boolean) => void }
  ): (() => void) => {
    const maxRetries = options?.maxRetries ?? 5
    const onConnectionChange = options?.onConnectionChange
    let eventSource: EventSource | null = null
    let retryCount = 0
    let retryTimeout: ReturnType<typeof setTimeout> | null = null
    let isManualClose = false
    let lastHeartbeat = Date.now()
    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

    const connect = () => {
      if (isManualClose) return

      eventSource = new EventSource(`${API_BASE}/sessions/${sessionId}/events`)

      eventSource.onopen = () => {
        retryCount = 0
        lastHeartbeat = Date.now()
        onConnectionChange?.(true)

        heartbeatCheckInterval = setInterval(() => {
          if (Date.now() - lastHeartbeat > 45000) {
            console.warn('SSE heartbeat timeout, reconnecting...')
            eventSource?.close()
            scheduleReconnect()
          }
        }, 15000)
      }

      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as StreamEvent
          lastHeartbeat = Date.now()
          if (event.type === 'heartbeat' || event.type === 'connected') {
            return
          }
          onEvent(event)
        } catch (err) {
          console.error('Failed to parse SSE event:', e.data, err)
        }
      }

      eventSource.onerror = () => {
        if (isManualClose) return
        console.error('SSE connection error')
        onConnectionChange?.(false)
        cleanup()
        scheduleReconnect()
      }
    }

    const cleanup = () => {
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval)
        heartbeatCheckInterval = null
      }
      eventSource?.close()
      eventSource = null
    }

    const scheduleReconnect = () => {
      if (isManualClose || retryCount >= maxRetries) {
        if (retryCount >= maxRetries) {
          console.error(`SSE max retries (${maxRetries}) reached, giving up`)
        }
        return
      }

      retryCount++
      const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000)
      console.log(`SSE reconnecting in ${delay}ms (attempt ${retryCount}/${maxRetries})`)

      retryTimeout = setTimeout(connect, delay)
    }

    connect()

    return () => {
      isManualClose = true
      if (retryTimeout) {
        clearTimeout(retryTimeout)
        retryTimeout = null
      }
      cleanup()
      onConnectionChange?.(false)
    }
  },

  respondPermission: async (
    sessionId: string,
    permissionId: string,
    payload: Omit<PermissionResponse, 'remember'>
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/permissions/${permissionId}?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('Failed to respond to permission')
  },

  respondToConfirmation: async (
    sessionId: string,
    toolCallId: string,
    approved: boolean
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/confirmation/${toolCallId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
    if (!res.ok) throw new Error('Failed to respond to confirmation')
  },

  respondToQuestion: async (
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/question/${toolCallId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    })
    if (!res.ok) throw new Error('Failed to respond to question')
  },

  getGitInfo: async (): Promise<{ branch: string | null }> => {
    const res = await fetch(`${API_BASE}/suggestions/git-info`)
    if (!res.ok) throw new Error('Failed to get git info')
    return res.json()
  },
}

export type { Message, MessageRole, PermissionMode, PermissionResponse, Session }
