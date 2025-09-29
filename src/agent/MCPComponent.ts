import { EventEmitter } from 'events';
import { McpClient as MCPClient, McpToolDefinition } from '../mcp/index.js';
import { BaseComponent } from './BaseComponent.js';

// 基础类型定义
interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

/**
 * MCP 会话接口
 */
export interface MCPSession {
  id: string;
  serverId: string;
  serverName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectedAt?: number;
  disconnectedAt?: number;
  error?: string;
}

/**
 * MCP 组件配置
 */
export interface MCPComponentConfig {
  enabled?: boolean;
  servers?: string[]; // 服务器名称列表
  autoConnect?: boolean;
  debug?: boolean;
}

/**
 * MCP 资源信息
 */
export interface MCPResourceInfo extends McpResource {
  serverId: string;
  serverName: string;
}

/**
 * MCP 工具信息
 */
export interface MCPToolInfo extends McpTool {
  serverId: string;
  serverName: string;
}

/**
 * MCP 组件 - 管理 MCP 连接和资源
 */
export class MCPComponent extends BaseComponent {
  private client?: MCPClient;
  private sessions: Map<string, MCPSession> = new Map();
  private resources: Map<string, MCPResourceInfo[]> = new Map();
  private tools: Map<string, MCPToolInfo[]> = new Map();
  private config: MCPComponentConfig;
  private eventEmitter: EventEmitter;

  constructor(id: string, config: MCPComponentConfig = {}) {
    super(id);
    this.config = {
      enabled: true,
      autoConnect: true,
      debug: false,
      ...config,
    };
    this.eventEmitter = new EventEmitter();
  }

  /**
   * 添加事件监听器
   */
  on(event: string, listener: (...args: any[]) => void): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  /**
   * 移除事件监听器
   */
  off(event: string, listener: (...args: any[]) => void): this {
    this.eventEmitter.off(event, listener);
    return this;
  }

  /**
   * 发射事件
   */
  private emit(event: string, ...args: any[]): boolean {
    return this.eventEmitter.emit(event, ...args);
  }

  /**
   * 初始化 MCP 组件
   */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      this.log('MCP 组件已禁用');
      return;
    }

    try {
      // 初始化 MCP 客户端
      this.client = new MCPClient({} as any); // 临时使用空配置
      await this.client.initialize();

      // 自动连接到配置的服务器
      if (this.config.autoConnect && this.config.servers) {
        await this.connectToServers(this.config.servers);
      }

      this.log('MCP 组件初始化完成');
    } catch (error) {
      this.log(`MCP 组件初始化失败: ${error}`);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 销毁组件
   */
  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
    }
    this.sessions.clear();
    this.resources.clear();
    this.tools.clear();
    this.eventEmitter.removeAllListeners();
  }

  /**
   * 连接到多个服务器
   */
  async connectToServers(serverNames: string[]): Promise<void> {
    for (const serverName of serverNames) {
      try {
        await this.connectToServer(serverName);
      } catch (error) {
        this.emit('error', { serverName, error });
      }
    }
  }

  /**
   * 连接到单个服务器
   */
  async connectToServer(serverId: string): Promise<MCPSession> {
    if (!this.client) {
      throw new Error('MCP 客户端未初始化');
    }

    await this.client.connectToServer(serverId);

    const session: MCPSession = {
      id: serverId,
      serverId,
      serverName: serverId,
      status: 'connected',
      connectedAt: Date.now(),
    };

    this.sessions.set(serverId, session);

    // 加载服务器资源和工具
    await this.loadServerResources(serverId);
    await this.loadServerTools(serverId);

    return session;
  }

  /**
   * 断开服务器连接
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    if (this.client) {
      await this.client.disconnectFromServer(serverName);
      this.sessions.delete(serverName);
    }
  }

  /**
   * 加载服务器资源
   */
  async loadServerResources(serverId: string): Promise<void> {
    if (!this.client) return;

    try {
      const resources = await this.client.listResources(serverId);
      const session = this.sessions.get(serverId);

      if (session) {
        const resourcesWithServer = resources.map((resource: any) => ({
          ...resource,
          serverId,
          serverName: session.serverName,
        }));

        this.resources.set(serverId, resourcesWithServer);
        this.log(`加载了 ${resources.length} 个资源从 ${session.serverName}`);
      }
    } catch (error) {
      this.log(`加载服务器资源失败: ${error}`);
    }
  }

  /**
   * 加载服务器工具
   */
  async loadServerTools(serverId: string): Promise<void> {
    if (!this.client) return;

    try {
      const tools = await this.client.listTools(serverId);
      const session = this.sessions.get(serverId);

      if (session) {
        const toolsWithServer = tools.map((tool: any) => ({
          ...tool,
          serverId,
          serverName: session.serverName,
        }));

        this.tools.set(serverId, toolsWithServer);
        this.log(`加载了 ${tools.length} 个工具从 ${session.serverName}`);
      }
    } catch (error) {
      this.log(`加载服务器工具失败: ${error}`);
    }
  }

  /**
   * 获取所有可用资源
   */
  getAllResources(): MCPResourceInfo[] {
    const allResources: MCPResourceInfo[] = [];
    for (const resources of this.resources.values()) {
      allResources.push(...resources);
    }
    return allResources;
  }

  /**
   * 获取所有可用工具
   */
  getAllTools(): MCPToolInfo[] {
    const allTools: MCPToolInfo[] = [];
    for (const tools of this.tools.values()) {
      allTools.push(...tools);
    }
    return allTools;
  }

  /**
   * 读取资源内容
   */
  async readResource(uri: string): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    // 查找包含该资源的服务器
    for (const [serverId, resources] of this.resources.entries()) {
      const resource = resources.find((r) => r.uri === uri);
      if (resource) {
        try {
          const content = await this.client.readResource(serverId, uri);
          return content;
        } catch (error) {
          this.emit('error', { serverId, uri, error });
          return null;
        }
      }
    }

    return null;
  }

  /**
   * 调用工具
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (!this.client) {
      throw new Error('MCP 客户端未初始化');
    }

    // 查找包含该工具的服务器
    for (const [serverId, tools] of this.tools.entries()) {
      const tool = tools.find((t) => t.name === toolName);
      if (tool) {
        try {
          return await this.client.callTool(toolName, args);
        } catch (error) {
          this.emit('error', { serverId, toolName, args, error });
          throw error;
        }
      }
    }

    throw new Error(`工具未找到: ${toolName}`);
  }

  /**
   * 搜索资源
   */
  searchResources(query: string): MCPResourceInfo[] {
    const allResources = this.getAllResources();
    return allResources.filter(
      (resource) =>
        resource.name.toLowerCase().includes(query.toLowerCase()) ||
        resource.description?.toLowerCase().includes(query.toLowerCase()) ||
        resource.uri.toLowerCase().includes(query.toLowerCase())
    );
  }

  /**
   * 搜索工具
   */
  searchTools(query: string): MCPToolInfo[] {
    const allTools = this.getAllTools();
    return allTools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(query.toLowerCase()) ||
        (tool.description &&
          tool.description.toLowerCase().includes(query.toLowerCase()))
    );
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): Array<{
    serverName: string;
    connected: boolean;
    resourceCount: number;
    toolCount: number;
  }> {
    return Array.from(this.sessions.values()).map((session) => ({
      serverName: session.serverName,
      connected: session.status === 'connected',
      resourceCount: this.resources.get(session.id)?.length || 0,
      toolCount: this.tools.get(session.id)?.length || 0,
    }));
  }

  /**
   * 根据 ID 获取会话
   */
  private getSessionById(sessionId: string): MCPSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 日志记录
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[MCPComponent] ${message}`);
    }
  }
}
