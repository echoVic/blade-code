/**
 * ACP 客户端
 *
 * 与 Blade ACP 服务器通信
 */

import type {
  AgentManifest,
  ACPMessage,
  RunInfo,
  CreateRunRequest,
  SessionInfo,
  ConfigInfo,
} from '../types/acp';

// 开发环境使用 Vite 代理，生产环境使用相对路径
const API_BASE = import.meta.env.VITE_API_BASE || '';

export class ACPClient {
  /**
   * 健康检查
   */
  async ping(): Promise<{ status: string; timestamp: string }> {
    const response = await fetch(`${API_BASE}/ping`);
    return response.json();
  }

  /**
   * 获取所有 Agent
   */
  async listAgents(): Promise<AgentManifest[]> {
    const response = await fetch(`${API_BASE}/agents`);
    const data = await response.json();
    return data.agents;
  }

  /**
   * 获取指定 Agent
   */
  async getAgent(name: string): Promise<AgentManifest> {
    const response = await fetch(`${API_BASE}/agents/${name}`);
    return response.json();
  }

  /**
   * 创建运行（同步模式）
   */
  async createSyncRun(
    agentName: string,
    input: ACPMessage[],
    sessionId?: string
  ): Promise<RunInfo> {
    const request: CreateRunRequest = {
      agent_name: agentName,
      session_id: sessionId,
      input,
      mode: 'sync',
    };

    const response = await fetch(`${API_BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    return response.json();
  }

  /**
   * 创建运行（流式模式）
   * 返回 SSE 事件流
   */
  async *createStreamRun(
    agentName: string,
    input: ACPMessage[],
    sessionId?: string,
    signal?: AbortSignal
  ): AsyncGenerator<{ event: string; data: unknown }> {
    const request: CreateRunRequest = {
      agent_name: agentName,
      session_id: sessionId,
      input,
      mode: 'stream',
    };

    // 先创建运行
    const response = await fetch(`${API_BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });

    const runInfo: RunInfo = await response.json();

    // 连接 SSE 事件流
    const eventsResponse = await fetch(`${API_BASE}/runs/${runInfo.id}/events`, {
      signal,
    });

    const reader = eventsResponse.body?.getReader();
    if (!reader) throw new Error('无法获取事件流');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 解析 SSE 事件
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      let currentData = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.slice(5).trim();
        } else if (line === '' && currentEvent && currentData) {
          try {
            yield { event: currentEvent, data: JSON.parse(currentData) };
          } catch {
            yield { event: currentEvent, data: currentData };
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }
  }

  /**
   * 获取运行状态
   */
  async getRun(runId: string): Promise<RunInfo> {
    const response = await fetch(`${API_BASE}/runs/${runId}`);
    return response.json();
  }

  /**
   * 取消运行
   */
  async cancelRun(runId: string): Promise<RunInfo> {
    const response = await fetch(`${API_BASE}/runs/${runId}/cancel`, {
      method: 'POST',
    });
    return response.json();
  }

  /**
   * 获取会话列表
   */
  async listSessions(): Promise<SessionInfo[]> {
    const response = await fetch(`${API_BASE}/api/sessions`);
    const data = await response.json();
    return data.sessions;
  }

  /**
   * 创建新会话
   */
  async createSession(): Promise<{ session_id: string }> {
    const response = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
    });
    return response.json();
  }

  /**
   * 获取会话详情
   */
  async getSession(sessionId: string): Promise<SessionInfo> {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
    return response.json();
  }

  /**
   * 获取会话消息历史
   */
  async getSessionMessages(sessionId: string): Promise<{ messages: ACPMessage[] }> {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
    return response.json();
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  /**
   * 获取配置
   */
  async getConfig(): Promise<ConfigInfo> {
    const response = await fetch(`${API_BASE}/api/config`);
    return response.json();
  }
}

export const acpClient = new ACPClient();
