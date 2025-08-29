import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { ToolManager } from '../../tools/ToolManager.js';
import { LoggerComponent } from '../../agent/LoggerComponent.js';
import {
  MCPClientInfo,
  MCPMessage,
  MCPPrompt,
  MCPResource,
  MCPResourceContent,
  MCPServerInfo,
  MCPTool,
  MCPToolResult,
} from '../types/mcp.js';

/**
 * MCP 服务器配置
 */
export interface MCPServerConfig {
  port?: number;
  host?: string;
  transport: 'ws' | 'stdio';
  auth?: {
    enabled: boolean;
    tokens?: string[];
  };
}

/**
 * MCP 服务器实现
 */
export class MCPServer extends EventEmitter {
  private server?: Server;
  private wsServer?: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private toolManager: ToolManager;
  private messageId = 0;

  private readonly serverInfo: MCPServerInfo = {
    name: 'blade-ai-server',
    version: '1.2.5',
    capabilities: {
      resources: {
        subscribe: true,
        listChanged: true,
      },
      tools: {
        listChanged: false,
      },
      prompts: {
        listChanged: false,
      },
    },
  };

  private readonly logger: LoggerComponent = new LoggerComponent('mcp-server');

  constructor(
    private config: MCPServerConfig,
    toolManager?: ToolManager
  ) {
    super();
    this.toolManager = toolManager || new ToolManager();
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    const port = this.config.port || 3001;
    const host = this.config.host || 'localhost';

    if (this.config.transport === 'ws') {
      this.server = createServer();
      this.wsServer = new WebSocketServer({ server: this.server });

      this.wsServer.on('connection', (ws, request) => {
        this.handleConnection(ws, request);
      });

      this.server.listen(port, host, () => {
        this.logger.info(`MCP Server listening on ws://${host}:${port}`, { 
          component: 'mcp-server', 
          action: 'start',
          host,
          port
        });
        this.emit('started', { host, port });
      });
    } else if (this.config.transport === 'stdio') {
      this.handleStdioConnection();
    }
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    if (this.wsServer) {
      this.wsServer.close();
    }
    if (this.server) {
      this.server.close();
    }
    this.clients.clear();
    this.emit('stopped');
  }

  /**
   * 处理 WebSocket 连接
   */
  private handleConnection(ws: WebSocket, request: any): void {
    const clientId = `client-${Date.now()}-${Math.random()}`;
    this.clients.set(clientId, ws);

    this.logger.info(`Client connected: ${clientId}`, { component: "mcp-server", action: "handleConnection", clientId });

    ws.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(clientId, message);
      } catch (error) {
        this.sendError(clientId, -32700, 'Parse error', error);
      }
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      this.logger.info(`Client disconnected: ${clientId}`, { component: "mcp-server", action: "handleConnection", clientId });
    });

    ws.on('error', error => {
      this.logger.error(`WebSocket error for ${clientId}:`, { error: (error as Error).message, clientId });
      this.clients.delete(clientId);
    });
  }

  /**
   * 处理 Stdio 连接
   */
  private handleStdioConnection(): void {
    process.stdin.on('data', async data => {
      try {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const message = JSON.parse(line);
            await this.handleMessage('stdio', message);
          }
        }
      } catch (error) {
        this.sendErrorToStdio(-32700, 'Parse error', error);
      }
    });

    this.logger.info("MCP Server listening on stdio", { component: "mcp-server", action: "handleStdioConnection" });
    this.emit('started', { transport: 'stdio' });
  }

  /**
   * 处理消息
   */
  private async handleMessage(clientId: string, message: MCPMessage): Promise<void> {
    try {
      switch (message.method) {
        case 'initialize':
          await this.handleInitialize(clientId, message);
          break;
        case 'notifications/initialized':
          // 客户端初始化完成
          break;
        case 'resources/list':
          await this.handleListResources(clientId, message);
          break;
        case 'resources/read':
          await this.handleReadResource(clientId, message);
          break;
        case 'tools/list':
          await this.handleListTools(clientId, message);
          break;
        case 'tools/call':
          await this.handleCallTool(clientId, message);
          break;
        case 'prompts/list':
          await this.handleListPrompts(clientId, message);
          break;
        case 'prompts/get':
          await this.handleGetPrompt(clientId, message);
          break;
        default:
          this.sendError(clientId, -32601, `Unknown method: ${message.method}`);
      }
    } catch (error) {
      this.sendError(clientId, -32603, 'Internal error', error);
    }
  }

  /**
   * 处理初始化请求
   */
  private async handleInitialize(clientId: string, message: MCPMessage): Promise<void> {
    const clientInfo = message.params?.clientInfo as MCPClientInfo;

    this.sendResponse(clientId, message.id, {
      protocolVersion: '2024-11-05',
      capabilities: this.serverInfo.capabilities,
      serverInfo: {
        name: this.serverInfo.name,
        version: this.serverInfo.version,
      },
    });

    this.logger.info(
      `Client initialized: ${clientInfo?.name || 'Unknown'} v${clientInfo?.version || '0.0.0'}`,
      { 
        component: 'mcp-server', 
        action: 'sendInitializedNotification',
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version 
      }
    );
  }

  /**
   * 处理列出资源
   */
  private async handleListResources(clientId: string, message: MCPMessage): Promise<void> {
    const resources: MCPResource[] = [
      {
        uri: 'file://workspace',
        name: 'Current Workspace',
        description: 'Files and directories in the current workspace',
        mimeType: 'application/json',
      },
      {
        uri: 'git://status',
        name: 'Git Status',
        description: 'Current git repository status',
        mimeType: 'application/json',
      },
      {
        uri: 'git://log',
        name: 'Git Log',
        description: 'Recent git commits',
        mimeType: 'application/json',
      },
    ];

    this.sendResponse(clientId, message.id, { resources });
  }

  /**
   * 处理读取资源
   */
  private async handleReadResource(clientId: string, message: MCPMessage): Promise<void> {
    const uri = message.params?.uri as string;

    try {
      let content: MCPResourceContent;

      if (uri === 'file://workspace') {
        const { readdir } = await import('fs/promises');
        const files = await readdir(process.cwd());
        content = {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(files, null, 2),
        };
      } else if (uri === 'git://status') {
        const { execSync } = await import('child_process');
        const status = execSync('git status --porcelain', { encoding: 'utf-8' });
        content = {
          uri,
          mimeType: 'text/plain',
          text: status,
        };
      } else if (uri === 'git://log') {
        const { execSync } = await import('child_process');
        const log = execSync('git log --oneline -10', { encoding: 'utf-8' });
        content = {
          uri,
          mimeType: 'text/plain',
          text: log,
        };
      } else {
        throw new Error(`Unknown resource URI: ${uri}`);
      }

      this.sendResponse(clientId, message.id, { contents: [content] });
    } catch (error) {
      this.sendError(clientId, -32603, `Failed to read resource: ${uri}`, error);
    }
  }

  /**
   * 处理列出工具
   */
  private async handleListTools(clientId: string, message: MCPMessage): Promise<void> {
    const bladeTools = this.toolManager.getTools();

    const tools: MCPTool[] = bladeTools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.parameters || {},
        required: tool.required || [],
      },
    }));

    this.sendResponse(clientId, message.id, { tools });
  }

  /**
   * 处理工具调用
   */
  private async handleCallTool(clientId: string, message: MCPMessage): Promise<void> {
    const toolName = message.params?.name as string;
    const toolArgs = message.params?.arguments as Record<string, any>;

    try {
      const response = await this.toolManager.callTool({
        toolName,
        parameters: toolArgs,
        context: {
          executionId: `mcp-${Date.now()}`,
          timestamp: Date.now(),
        },
      });

      const mcpResponse: MCPToolResult = {
        content: [
          {
            type: 'text',
            text:
              typeof response.result.data === 'string'
                ? response.result.data
                : JSON.stringify(response.result.data, null, 2),
          },
        ],
        isError: !response.result.success,
      };

      this.sendResponse(clientId, message.id, mcpResponse);
    } catch (error) {
      const response: MCPToolResult = {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };

      this.sendResponse(clientId, message.id, response);
    }
  }

  /**
   * 处理列出提示
   */
  private async handleListPrompts(clientId: string, message: MCPMessage): Promise<void> {
    const prompts: MCPPrompt[] = [
      {
        name: 'code_review',
        description: 'Review code for quality, security, and best practices',
        arguments: [
          {
            name: 'file_path',
            description: 'Path to the file to review',
            required: true,
          },
        ],
      },
      {
        name: 'generate_docs',
        description: 'Generate documentation for code',
        arguments: [
          {
            name: 'file_path',
            description: 'Path to the file to document',
            required: true,
          },
        ],
      },
    ];

    this.sendResponse(clientId, message.id, { prompts });
  }

  /**
   * 处理获取提示
   */
  private async handleGetPrompt(clientId: string, message: MCPMessage): Promise<void> {
    const promptName = message.params?.name as string;
    const args = message.params?.arguments as Record<string, any>;

    // 这里可以根据提示名称生成相应的提示内容
    // 暂时返回一个简单的示例
    this.sendResponse(clientId, message.id, {
      description: `Generated prompt for ${promptName}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please ${promptName} for the following parameters: ${JSON.stringify(args)}`,
          },
        },
      ],
    });
  }

  /**
   * 发送响应
   */
  private sendResponse(clientId: string, messageId: any, result: any): void {
    const response: MCPMessage = {
      jsonrpc: '2.0',
      id: messageId,
      result,
    };

    if (clientId === 'stdio') {
      process.stdout.write(JSON.stringify(response) + '\n');
    } else {
      const client = this.clients.get(clientId);
      if (client) {
        client.send(JSON.stringify(response));
      }
    }
  }

  /**
   * 发送错误
   */
  private sendError(clientId: string, code: number, message: string, data?: any): void {
    const response: MCPMessage = {
      jsonrpc: '2.0',
      error: {
        code,
        message,
        data,
      },
    };

    if (clientId === 'stdio') {
      process.stdout.write(JSON.stringify(response) + '\n');
    } else {
      const client = this.clients.get(clientId);
      if (client) {
        client.send(JSON.stringify(response));
      }
    }
  }

  /**
   * 发送错误到 Stdio
   */
  private sendErrorToStdio(code: number, message: string, data?: any): void {
    this.sendError('stdio', code, message, data);
  }
}
