import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  MCP_VERSION,
  McpConnectionStatus,
  type McpInitializeRequest,
  type McpInitializeResponse,
  type McpMessage,
  type McpServerConfig,
  type McpToolCallRequest,
  type McpToolCallResponse,
  type McpToolDefinition,
} from './types.js';

/**
 * MCP客户端
 * 负责与MCP服务器建立连接和通信
 */
export class McpClient extends EventEmitter {
  private status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED;
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private tools = new Map<string, McpToolDefinition>();
  private serverInfo: { name: string; version: string } | null = null;

  constructor(private config: McpServerConfig) {
    super();
  }

  get connectionStatus(): McpConnectionStatus {
    return this.status;
  }

  get availableTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get server(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  /**
   * 连接到MCP服务器
   */
  async connect(): Promise<void> {
    if (this.status !== McpConnectionStatus.DISCONNECTED) {
      throw new Error('客户端已连接或正在连接中');
    }

    try {
      this.setStatus(McpConnectionStatus.CONNECTING);

      // 启动MCP服务器进程
      this.process = spawn(this.config.command, this.config.args || [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.setupProcessHandlers();

      // 发送初始化请求
      const initResponse = await this.sendInitializeRequest();
      this.serverInfo = initResponse.serverInfo;

      // 获取工具列表
      await this.loadTools();

      this.setStatus(McpConnectionStatus.CONNECTED);
      this.emit('connected', this.serverInfo);
    } catch (error) {
      this.setStatus(McpConnectionStatus.ERROR);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.tools.clear();
    this.pendingRequests.clear();
    this.serverInfo = null;
    this.setStatus(McpConnectionStatus.DISCONNECTED);
    this.emit('disconnected');
  }

  /**
   * 调用MCP工具
   */
  async callTool(name: string, arguments_: Record<string, any> = {}): Promise<McpToolCallResponse> {
    if (this.status !== McpConnectionStatus.CONNECTED) {
      throw new Error('客户端未连接到服务器');
    }

    if (!this.tools.has(name)) {
      throw new Error(`工具 "${name}" 不存在`);
    }

    const request: McpToolCallRequest = {
      method: 'tools/call',
      params: {
        name,
        arguments: arguments_,
      },
    };

    return await this.sendRequest(request);
  }

  /**
   * 发送请求到MCP服务器
   */
  private async sendRequest(request: any): Promise<any> {
    if (!this.process || !this.process.stdin) {
      throw new Error('服务器进程不可用');
    }

    const id = ++this.messageId;
    const message: McpMessage = {
      jsonrpc: '2.0',
      id,
      ...request,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('请求超时'));
      }, this.config.timeout || 30000);

      this.pendingRequests.set(id, {
        resolve: (result: any) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const messageStr = JSON.stringify(message) + '\n';
      this.process!.stdin!.write(messageStr);
    });
  }

  /**
   * 发送初始化请求
   */
  private async sendInitializeRequest(): Promise<McpInitializeResponse> {
    const request: McpInitializeRequest = {
      method: 'initialize',
      params: {
        protocolVersion: MCP_VERSION,
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: {
          name: 'Blade-AI',
          version: '1.0.0',
        },
      },
    };

    return await this.sendRequest(request);
  }

  /**
   * 加载工具列表
   */
  private async loadTools(): Promise<void> {
    try {
      const response = await this.sendRequest({ method: 'tools/list' });

      if (response.tools && Array.isArray(response.tools)) {
        this.tools.clear();
        for (const tool of response.tools) {
          this.tools.set(tool.name, tool);
        }
        this.emit('toolsUpdated', this.availableTools);
      }
    } catch (error) {
      console.warn('加载MCP工具列表失败:', error);
    }
  }

  /**
   * 设置进程事件处理器
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    let buffer = '';

    this.process.stdout?.on('data', data => {
      buffer += data.toString();

      // 处理完整的JSON消息（以换行符分隔）
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as McpMessage;
            this.handleMessage(message);
          } catch (error) {
            console.warn('解析MCP消息失败:', error, line);
          }
        }
      }
    });

    this.process.stderr?.on('data', data => {
      const error = data.toString();
      console.warn('MCP服务器错误:', error);
      this.emit('serverError', error);
    });

    this.process.on('close', code => {
      if (this.status === McpConnectionStatus.CONNECTED) {
        this.setStatus(McpConnectionStatus.ERROR);
        this.emit('error', new Error(`MCP服务器意外退出，退出码: ${code}`));
      }
    });

    this.process.on('error', error => {
      this.setStatus(McpConnectionStatus.ERROR);
      this.emit('error', error);
    });
  }

  /**
   * 处理从服务器接收的消息
   */
  private handleMessage(message: McpMessage): void {
    if (message.id !== undefined) {
      // 这是对请求的响应
      const pending = this.pendingRequests.get(message.id as number);
      if (pending) {
        this.pendingRequests.delete(message.id as number);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // 这是服务器发起的通知
      this.handleNotification(message);
    }
  }

  /**
   * 处理服务器通知
   */
  private handleNotification(message: McpMessage): void {
    switch (message.method) {
      case 'tools/list_changed':
        this.loadTools();
        break;

      case 'logging/message':
        this.emit('serverLog', message.params);
        break;

      default:
        console.debug('未处理的MCP通知:', message.method);
    }
  }

  /**
   * 设置连接状态
   */
  private setStatus(status: McpConnectionStatus): void {
    const oldStatus = this.status;
    this.status = status;
    this.emit('statusChanged', status, oldStatus);
  }
}
