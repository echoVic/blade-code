import type {
  BusEvent,
  Message,
  MessageRole,
  ModelConfig,
  PermissionMode,
  PermissionResponse,
  Session
} from '@api/schemas'
import { PermissionModeEnum } from '@api/schemas'

export { PermissionModeEnum }
export type { BusEvent, Message, MessageRole, ModelConfig, PermissionMode, Session }

const API_BASE = ''

export interface StreamEvent {
  type: string
  properties: Record<string, unknown>
}

class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }))
      throw new Error(error.error?.message || error.message || 'Request failed')
    }

    return response.json()
  }

  async listSessions(): Promise<Session[]> {
    return this.request<Session[]>('/sessions')
  }

  async createSession(projectPath?: string, title?: string): Promise<Session> {
    const defaultTitle = title || this.generateDefaultTitle()
    return this.request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectPath, title: defaultTitle }),
    })
  }

  private generateDefaultTitle(): string {
    const now = new Date()
    const year = String(now.getFullYear()).slice(-2)
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    return `Session ${year}-${month}-${day} ${hours}:${minutes}`
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}`, { method: 'DELETE' })
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    const result = await this.request<Message[]>(`/sessions/${sessionId}/message`)
    const now = Date.now()
    return result.map((m, index) => {
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
  }

  sendMessageStream(
    sessionId: string,
    content: string,
    permissionMode?: PermissionMode,
    onEvent?: (event: StreamEvent) => void
  ): { abort: () => void; done: Promise<void> } {
    const abortController = new AbortController()

    const done = (async () => {
      const url = `${this.baseUrl}/sessions/${sessionId}/message`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ content, permissionMode }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }))
        throw new Error(error.error?.message || error.message || 'Request failed')
      }

      if (!response.body) {
        throw new Error('No response body')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data) {
              try {
                const event = JSON.parse(data) as StreamEvent
                onEvent?.(event)
              } catch {
                // Ignore invalid JSON
              }
            }
          }
        }
      }

      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6)
        if (data) {
          try {
            const event = JSON.parse(data) as StreamEvent
            onEvent?.(event)
          } catch {
            // Ignore invalid JSON
          }
        }
      }
    })()

    return {
      abort: () => abortController.abort(),
      done,
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/abort`, { method: 'POST' })
  }

  async getGitInfo(): Promise<{ branch: string | null }> {
    return this.request<{ branch: string | null }>('/suggestions/git-info')
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    payload: Omit<PermissionResponse, 'remember'>
  ): Promise<void> {
    await this.request(`/permissions/${permissionId}?sessionId=${sessionId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }
}

export const api = new ApiClient()

function normalizeContent(content: unknown): string {
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
