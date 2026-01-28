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
    onEvent: (event: StreamEvent) => void
  ): (() => void) => {
    const eventSource = new EventSource(`${API_BASE}/sessions/${sessionId}/events`)
    eventSource.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data) as StreamEvent)
      } catch (err) {
        console.error('Failed to parse SSE event:', e.data, err)
      }
    }
    eventSource.onerror = () => {
      console.error('SSE connection error')
    }
    return () => eventSource.close()
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

  getGitInfo: async (): Promise<{ branch: string | null }> => {
    const res = await fetch(`${API_BASE}/suggestions/git-info`)
    if (!res.ok) throw new Error('Failed to get git info')
    return res.json()
  },
}

export type { Message, MessageRole, PermissionMode, PermissionResponse, Session }
