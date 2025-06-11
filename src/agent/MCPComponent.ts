import { EventEmitter } from 'events';
import { MCPClient, MCPConnectionConfig, MCPResource, MCPSession, MCPTool } from '../mcp/index.js';
import { BaseComponent } from './BaseComponent.js';

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
export interface MCPResourceInfo extends MCPResource {
  serverId: string;
  serverName: string;
}

/**
 * MCP 工具信息
 */
export interface MCPToolInfo extends MCPTool {
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

    this.client = new MCPClient();

    // 设置事件监听
    this.client.on('connected', session => {
      this.log(`MCP 服务器连接成功: ${session.config.name}`);
      this.sessions.set(session.config.name, session);
      this.emit('serverConnected', session);
    });

    this.client.on('disconnected', sessionId => {
      this.log(`MCP 服务器断开连接: ${sessionId}`);
      // 清理相关数据
      for (const [name, session] of this.sessions.entries()) {
        if (session.id === sessionId) {
          this.sessions.delete(name);
          this.resources.delete(sessionId);
          this.tools.delete(sessionId);
          break;
        }
      }
      this.emit('serverDisconnected', sessionId);
    });

    this.client.on('error', error => {
      this.log(`MCP 客户端错误: ${error.message}`);
      this.emit('error', error);
    });

    // 自动连接配置的服务器
    if (this.config.autoConnect && this.config.servers) {
      await this.connectToServers(this.config.servers);
    }

    this.log('MCP 组件初始化完成');
  }

  /**
   * 销毁 MCP 组件
   */
  async destroy(): Promise<void> {
    if (this.client) {
      // 断开所有连接
      for (const session of this.sessions.values()) {
        await this.client.disconnect(session.id);
      }
    }

    this.sessions.clear();
    this.resources.clear();
    this.tools.clear();

    this.log('MCP 组件已销毁');
  }

  /**
   * 连接到多个服务器
   */
  async connectToServers(serverNames: string[]): Promise<void> {
    const { mcpConfig } = await import('../mcp/index.js');

    for (const serverName of serverNames) {
      try {
        const serverConfig = mcpConfig.getServer(serverName);
        if (!serverConfig) {
          this.log(`未找到服务器配置: ${serverName}`);
          continue;
        }

        await this.connectToServer(serverConfig);
      } catch (error) {
        this.log(`连接服务器失败 ${serverName}: ${error}`);
      }
    }
  }

  /**
   * 连接到单个服务器
   */
  async connectToServer(config: MCPConnectionConfig): Promise<MCPSession> {
    if (!this.client) {
      throw new Error('MCP 客户端未初始化');
    }

    this.log(`连接到 MCP 服务器: ${config.name}`);
    const session = await this.client.connect(config);

    // 获取服务器资源和工具
    await this.loadServerResources(session.id);
    await this.loadServerTools(session.id);

    return session;
  }

  /**
   * 断开服务器连接
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const session = this.sessions.get(serverName);
    if (session && this.client) {
      await this.client.disconnect(session.id);
    }
  }

  /**
   * 加载服务器资源
   */
  async loadServerResources(sessionId: string): Promise<void> {
    if (!this.client) return;

    try {
      const resources = await this.client.listResources(sessionId);
      const session = this.getSessionById(sessionId);

      if (session) {
        const resourcesWithServer = resources.map(resource => ({
          ...resource,
          serverId: sessionId,
          serverName: session.config.name,
        }));

        this.resources.set(sessionId, resourcesWithServer);
        this.log(`加载了 ${resources.length} 个资源从 ${session.config.name}`);
      }
    } catch (error) {
      this.log(`加载服务器资源失败: ${error}`);
    }
  }

  /**
   * 加载服务器工具
   */
  async loadServerTools(sessionId: string): Promise<void> {
    if (!this.client) return;

    try {
      const tools = await this.client.listTools(sessionId);
      const session = this.getSessionById(sessionId);

      if (session) {
        const toolsWithServer = tools.map(tool => ({
          ...tool,
          serverId: sessionId,
          serverName: session.config.name,
        }));

        this.tools.set(sessionId, toolsWithServer);
        this.log(`加载了 ${tools.length} 个工具从 ${session.config.name}`);
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
    if (!this.client) return null;

    // 查找包含该资源的服务器
    for (const [sessionId, resources] of this.resources.entries()) {
      const resource = resources.find(r => r.uri === uri);
      if (resource) {
        try {
          const content = await this.client.readResource(sessionId, uri);
          return content.text || null;
        } catch (error) {
          this.log(`读取资源失败 ${uri}: ${error}`);
          return null;
        }
      }
    }

    return null;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (!this.client) {
      throw new Error('MCP 客户端未初始化');
    }

    // 查找包含该工具的服务器
    for (const [sessionId, tools] of this.tools.entries()) {
      const tool = tools.find(t => t.name === toolName);
      if (tool) {
        try {
          const result = await this.client.callTool(sessionId, {
            name: toolName,
            arguments: args,
          });

          if (result.isError) {
            throw new Error(`工具执行错误: ${result.content[0]?.text || '未知错误'}`);
          }

          return result.content[0]?.text || result;
        } catch (error) {
          this.log(`调用 MCP 工具失败 ${toolName}: ${error}`);
          throw error;
        }
      }
    }

    throw new Error(`未找到 MCP 工具: ${toolName}`);
  }

  /**
   * 搜索资源
   */
  searchResources(query: string): MCPResourceInfo[] {
    const allResources = this.getAllResources();
    return allResources.filter(
      resource =>
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
      tool =>
        tool.name.toLowerCase().includes(query.toLowerCase()) ||
        tool.description.toLowerCase().includes(query.toLowerCase())
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
    return Array.from(this.sessions.values()).map(session => ({
      serverName: session.config.name,
      connected: session.connected,
      resourceCount: this.resources.get(session.id)?.length || 0,
      toolCount: this.tools.get(session.id)?.length || 0,
    }));
  }

  /**
   * 根据 ID 获取会话
   */
  private getSessionById(sessionId: string): MCPSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return undefined;
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
