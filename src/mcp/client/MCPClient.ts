import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  MCPClientInfo,
  MCPConnectionConfig,
  MCPMessage,
  MCPResource,
  MCPResourceContent,
  MCPSession,
  MCPTool,
  MCPToolCall,
  MCPToolResult,
} from '../types/mcp.js';

/**
 * MCP 客户端实现
 */
export class MCPClient extends EventEmitter {
  private sessions: Map<string, MCPSession> = new Map();
  private connections: Map<string, WebSocket | any> = new Map();
  private messageId = 0;

  private readonly clientInfo: MCPClientInfo = {
    name: 'blade-ai',
    version: '1.2.5',
    capabilities: {
      sampling: {},
    },
  };

  constructor() {
    super();
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(config: MCPConnectionConfig): Promise<MCPSession> {
    const sessionId = `${config.name}-${Date.now()}`;

    try {
      let connection: WebSocket | any;

      switch (config.transport) {
        case 'ws':
          connection = await this.connectWebSocket(config);
          break;
        case 'stdio':
          connection = await this.connectStdio(config);
          break;
        case 'sse':
          throw new Error('SSE transport not implemented yet');
        default:
          throw new Error(`Unsupported transport: ${config.transport}`);
      }

      const session: MCPSession = {
        id: sessionId,
        config,
        connected: true,
        lastActivity: new Date(),
      };

      this.sessions.set(sessionId, session);
      this.connections.set(sessionId, connection);

      // 执行初始化握手
      await this.performHandshake(sessionId);

      this.emit('connected', session);
      return session;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const connection = this.connections.get(sessionId);

    if (session) {
      session.connected = false;
    }

    if (connection) {
      if (connection instanceof WebSocket) {
        connection.close();
      } else if (connection.kill) {
        connection.kill();
      }
      this.connections.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    this.emit('disconnected', sessionId);
  }

  /**
   * 获取所有会话
   */
  getSessions(): MCPSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 获取指定会话
   */
  getSession(sessionId: string): MCPSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 列出资源
   */
  async listResources(sessionId: string): Promise<MCPResource[]> {
    const response = await this.sendRequest(sessionId, {
      method: 'resources/list',
      params: {},
    });

    return response.resources || [];
  }

  /**
   * 读取资源内容
   */
  async readResource(sessionId: string, uri: string): Promise<MCPResourceContent> {
    const response = await this.sendRequest(sessionId, {
      method: 'resources/read',
      params: { uri },
    });

    return response.contents[0];
  }

  /**
   * 列出工具
   */
  async listTools(sessionId: string): Promise<MCPTool[]> {
    const response = await this.sendRequest(sessionId, {
      method: 'tools/list',
      params: {},
    });

    return response.tools || [];
  }

  /**
   * 调用工具
   */
  async callTool(sessionId: string, toolCall: MCPToolCall): Promise<MCPToolResult> {
    const response = await this.sendRequest(sessionId, {
      method: 'tools/call',
      params: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });

    return response;
  }

  /**
   * 发送请求到 MCP 服务器
   */
  private async sendRequest(sessionId: string, request: Partial<MCPMessage>): Promise<any> {
    const connection = this.connections.get(sessionId);
    const session = this.sessions.get(sessionId);

    if (!connection || !session?.connected) {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const message: MCPMessage = {
      jsonrpc: '2.0',
      id: ++this.messageId,
      ...request,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, session.config.timeout || 30000);

      const handleMessage = (data: any) => {
        try {
          const response = typeof data === 'string' ? JSON.parse(data) : data;

          if (response.id === message.id) {
            clearTimeout(timeout);
            connection.off?.('message', handleMessage);

            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          }
        } catch (error) {
          reject(error);
        }
      };

      if (connection instanceof WebSocket) {
        connection.on('message', handleMessage);
        connection.send(JSON.stringify(message));
      } else {
        // Handle stdio connection
        const responseHandler = (data: Buffer) => {
          try {
            const response = JSON.parse(data.toString().trim());
            if (response.id === message.id) {
              clearTimeout(timeout);
              connection.stdout?.off('data', responseHandler);

              if (response.error) {
                reject(new Error(response.error.message));
              } else {
                resolve(response.result);
              }
            }
          } catch (error) {
            // Ignore JSON parse errors for partial messages
          }
        };
        connection.stdout?.on('data', responseHandler);
        connection.stdin?.write(JSON.stringify(message) + '\n');
      }
    });
  }

  /**
   * WebSocket 连接
   */
  private async connectWebSocket(config: MCPConnectionConfig): Promise<WebSocket> {
    if (!config.endpoint) {
      throw new Error('WebSocket endpoint is required');
    }

    const ws = new WebSocket(config.endpoint);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, config.timeout || 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });
    });
  }

  /**
   * Stdio 连接
   */
  private async connectStdio(config: MCPConnectionConfig): Promise<any> {
    const { spawn } = await import('child_process');

    if (!config.command) {
      throw new Error('Command is required for stdio transport');
    }

    const childProcess = spawn(config.command, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Process start timeout'));
      }, config.timeout || 10000);

      childProcess.on('spawn', () => {
        clearTimeout(timeout);
        resolve(childProcess);
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      childProcess.stdout?.on('data', (data: Buffer) => {
        this.handleMessage(data.toString());
      });
    });
  }

  /**
   * 处理消息
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      this.emit('message', message);
    } catch (error) {
      this.emit('error', new Error(`Invalid JSON message: ${data}`));
    }
  }

  /**
   * 执行握手
   */
  private async performHandshake(sessionId: string): Promise<void> {
    try {
      const response = await this.sendRequest(sessionId, {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: this.clientInfo.capabilities,
          clientInfo: {
            name: this.clientInfo.name,
            version: this.clientInfo.version,
          },
        },
      });

      const session = this.sessions.get(sessionId);
      if (session) {
        session.serverInfo = {
          name: response.serverInfo?.name || 'Unknown',
          version: response.serverInfo?.version || '0.0.0',
          capabilities: response.capabilities || {},
        };
      }

      // 发送初始化完成通知
      const connection = this.connections.get(sessionId);
      if (connection instanceof WebSocket) {
        connection.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          })
        );
      } else {
        connection.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }) + '\n'
        );
      }
    } catch (error) {
      throw new Error(`Handshake failed: ${error}`);
    }
  }
}
