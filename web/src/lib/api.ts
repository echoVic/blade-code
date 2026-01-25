import type { BusEvent, SessionMessage, SessionMetadata } from './types'

const API_BASE = ''

export type Session = SessionMetadata & {
  isActive?: boolean
}

export type Message = SessionMessage

export type { BusEvent }

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
    const result = await this.request<Array<{ id: string; role: string; content: string }>>(`/sessions/${sessionId}/message`)
    return result.map((m) => ({
      id: m.id,
      role: m.role as Message['role'],
      content: m.content || '',
      timestamp: Date.now(),
    }))
  }

  async sendMessage(sessionId: string, content: string): Promise<Message> {
    const result = await this.request<{ messageId: string; role: string; content: string; timestamp: string }>(`/sessions/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    return {
      id: result.messageId,
      role: result.role as Message['role'],
      content: result.content,
      timestamp: new Date(result.timestamp).getTime(),
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}/abort`, { method: 'POST' })
  }

  async getGitInfo(): Promise<{ branch: string | null }> {
    return this.request<{ branch: string | null }>('/suggestions/git-info')
  }

  subscribeEvents(onEvent: (event: BusEvent) => void): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/event`)
    
    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as BusEvent
        onEvent(event)
      } catch (err) {
        console.error('Failed to parse SSE event:', e.data, err)
      }
    }

    eventSource.onerror = () => {
      console.error('SSE connection error')
    }

    return () => {
      eventSource.close()
    }
  }
}

export const api = new ApiClient()
