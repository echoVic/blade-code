import WebSocket from 'ws';
import type { BladeConfig } from '../config/types/index.js';
import type { Agent } from '../agent/Agent.js';

export class IdeClient {
  private config: BladeConfig;
  private agent: Agent | null = null;
  private websocket: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectInterval: number;

  constructor(config: BladeConfig) {
    this.config = config;
    this.maxReconnectAttempts = 5;
    this.reconnectInterval = 5000; // 5秒
  }

  public async initialize(agent: Agent): Promise<void> {
    this.agent = agent;
    
    if (this.config.debug === true) {
      await this.connectToIde();
    }
  }

  private async connectToIde(): Promise<void> {
    try {
      const idePort = process.env.BLADE_IDE_PORT || '3000';
      const ideHost = process.env.BLADE_IDE_HOST || 'localhost';
      const wsUrl = `ws://${ideHost}:${idePort}`;
      
      this.websocket = new WebSocket(wsUrl);
      
      this.websocket.on('open', () => {
        console.log(`连接到IDE: ${wsUrl}`);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.sendInitializationMessage();
      });
      
      this.websocket.on('message', (data) => {
        this.handleIdeMessage(data.toString());
      });
      
      this.websocket.on('close', () => {
        console.log('与IDE的连接已断开');
        this.isConnected = false;
        this.attemptReconnect();
      });
      
      this.websocket.on('error', (error) => {
        console.error('IDE连接错误:', error);
        this.isConnected = false;
      });
    } catch (error) {
      console.error('连接IDE失败:', error);
    }
  }

  private sendInitializationMessage(): void {
    if (!this.websocket || !this.isConnected) return;
    
    const initMessage: IdeMessage = {
      type: 'init',
      payload: {
        clientId: 'blade-ai',
        version: this.config.version,
        capabilities: this.getAgentCapabilities()
      },
      timestamp: Date.now()
    };
    
    this.websocket.send(JSON.stringify(initMessage));
  }

  private getAgentCapabilities(): string[] {
    if (!this.agent) return [];
    
    // 这里应该返回Agent的实际能力
    // 暂时返回一些默认能力
    return [
      'chat',
      'code-generation',
      'file-operations',
      'git-operations',
      'tool-execution'
    ];
  }

  private handleIdeMessage(message: string): void {
    try {
      const ideMessage: IdeMessage = JSON.parse(message);
      
      switch (ideMessage.type) {
        case 'request':
          this.handleRequest(ideMessage);
          break;
        case 'notification':
          this.handleNotification(ideMessage);
          break;
        case 'response':
          this.handleResponse(ideMessage);
          break;
        default:
          console.warn('未知的IDE消息类型:', ideMessage.type);
      }
    } catch (error) {
      console.error('处理IDE消息失败:', error);
    }
  }

  private async handleRequest(message: IdeMessage): Promise<void> {
    if (!this.agent) {
      this.sendErrorResponse(message.id!, 'Agent未初始化');
      return;
    }
    
    try {
      let result: any;
      
      switch (message.method) {
        case 'chat':
          result = await this.agent.chat(message.params?.message || '');
          break;
          
        case 'generateCode':
          result = await this.agent.chat(`Generate code: ${JSON.stringify(message.params)}`);
          break;
          
        case 'executeTool':
          result = await this.agent.chat(`Execute tool: ${JSON.stringify(message.params)}`);
          break;
          
        case 'analyzeFiles':
          result = await this.agent.chat(`Analyze files: ${JSON.stringify(message.params)}`);
          break;
          
        default:
          this.sendErrorResponse(message.id || 'unknown', `不支持的方法: ${message.method}`);
          return;
      }
      
      this.sendSuccessResponse(message.id!, result);
    } catch (error) {
      console.error('处理IDE请求失败:', error);
      this.sendErrorResponse(message.id!, error instanceof Error ? error.message : String(error));
    }
  }

  private handleNotification(message: IdeMessage): void {
    // 处理通知消息
    console.log('收到IDE通知:', message.method, message.params);
  }

  private handleResponse(message: IdeMessage): void {
    // 处理响应消息
    console.log('收到IDE响应:', message.id, message.result);
  }

  private sendSuccessResponse(id: string, result: any): void {
    if (!this.websocket || !this.isConnected) return;
    
    const response: IdeMessage = {
      type: 'response',
      id,
      result,
      timestamp: Date.now()
    };
    
    this.websocket.send(JSON.stringify(response));
  }

  private sendErrorResponse(id: string, error: string): void {
    if (!this.websocket || !this.isConnected) return;
    
    const response: IdeMessage = {
      type: 'response',
      id,
      error,
      timestamp: Date.now()
    };
    
    this.websocket.send(JSON.stringify(response));
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('达到最大重连次数，停止重连');
      return;
    }
    
    this.reconnectAttempts++;
    console.log(`尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connectToIde();
    }, this.reconnectInterval);
  }

  public async sendNotification(method: string, params?: any): Promise<void> {
    if (!this.websocket || !this.isConnected) {
      console.warn('未连接到IDE，无法发送通知');
      return;
    }
    
    const notification: IdeMessage = {
      type: 'notification',
      method,
      params,
      timestamp: Date.now()
    };
    
    this.websocket.send(JSON.stringify(notification));
  }

  public async sendDocumentUpdate(filePath: string, content: string): Promise<void> {
    await this.sendNotification('documentUpdate', {
      filePath,
      content,
      timestamp: Date.now()
    });
  }

  public async sendDiagnosticUpdate(filePath: string, diagnostics: IdeDiagnostic[]): Promise<void> {
    await this.sendNotification('diagnosticUpdate', {
      filePath,
      diagnostics,
      timestamp: Date.now()
    });
  }

  public async sendProgressUpdate(task: string, progress: number, message?: string): Promise<void> {
    await this.sendNotification('progressUpdate', {
      task,
      progress,
      message,
      timestamp: Date.now()
    });
  }

  public isConnectedToIde(): boolean {
    return this.isConnected;
  }

  public async destroy(): Promise<void> {
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    
    this.isConnected = false;
    this.reconnectAttempts = 0;
  }
}

// 类型定义
interface IdeMessage {
  type: 'init' | 'request' | 'response' | 'notification';
  id?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
  payload?: any;
  timestamp: number;
}

interface IdeDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string | number;
}