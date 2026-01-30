import { EventEmitter } from 'events';
import type { McpServerConfig } from '../config/types.js';
import type { Tool } from '../tools/types/index.js';
import { createMcpTool } from './createMcpTool.js';
import { McpClient } from './McpClient.js';
import { McpConnectionStatus, type McpToolDefinition } from './types.js';

/**
 * MCP服务器信息
 */
export interface McpServerInfo {
  config: McpServerConfig;
  client: McpClient;
  status: McpConnectionStatus;
  connectedAt?: Date;
  lastError?: Error;
  tools: McpToolDefinition[];
}

/**
 * MCP注册表
 * 管理MCP服务器连接和工具发现
 */
export class McpRegistry extends EventEmitter {
  private static instance: McpRegistry | null = null;
  private servers: Map<string, McpServerInfo> = new Map();
  private isDiscovering = false;

  private constructor() {
    super();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): McpRegistry {
    if (!McpRegistry.instance) {
      McpRegistry.instance = new McpRegistry();
    }
    return McpRegistry.instance;
  }

  /**
   * 注册MCP服务器
   */
  async registerServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`MCP服务器 "${name}" 已经注册`);
    }

    const client = new McpClient(config, name, config.healthCheck);
    const serverInfo: McpServerInfo = {
      config,
      client,
      status: McpConnectionStatus.DISCONNECTED,
      tools: [],
    };

    // 设置客户端事件处理器
    this.setupClientEventHandlers(client, serverInfo, name);

    this.servers.set(name, serverInfo);
    this.emit('serverRegistered', name, serverInfo);

    try {
      await this.connectServer(name);
    } catch (error) {
      console.warn(`MCP服务器 "${name}" 连接失败:`, error);
    }
  }

  /**
   * 注销MCP服务器
   */
  async unregisterServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    try {
      await serverInfo.client.disconnect();
    } catch (error) {
      console.warn(`断开MCP服务器 "${name}" 时出错:`, error);
    }

    this.servers.delete(name);
    this.emit('serverUnregistered', name);
  }

  /**
   * 连接到指定服务器
   */
  async connectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    if (serverInfo.status === McpConnectionStatus.CONNECTED) {
      return;
    }

    try {
      serverInfo.status = McpConnectionStatus.CONNECTING;
      await serverInfo.client.connect();
      serverInfo.connectedAt = new Date();
      serverInfo.lastError = undefined;
      serverInfo.tools = serverInfo.client.availableTools;
    } catch (error) {
      serverInfo.lastError = error as Error;
      serverInfo.status = McpConnectionStatus.ERROR;
      throw error;
    }
  }

  /**
   * 断开指定服务器
   */
  async disconnectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    await serverInfo.client.disconnect();
    serverInfo.connectedAt = undefined;
  }

  /**
   * 重连指定服务器（用于从 ERROR 状态恢复）
   * 这个方法可以在首次连接失败或意外断开后使用
   */
  async reconnectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    // 如果已连接，先断开
    if (serverInfo.status === McpConnectionStatus.CONNECTED) {
      await serverInfo.client.disconnect();
    }

    // 尝试重新连接
    try {
      serverInfo.status = McpConnectionStatus.CONNECTING;
      await serverInfo.client.connect();
      serverInfo.connectedAt = new Date();
      serverInfo.lastError = undefined;
      serverInfo.tools = serverInfo.client.availableTools;
    } catch (error) {
      serverInfo.lastError = error as Error;
      serverInfo.status = McpConnectionStatus.ERROR;
      throw error;
    }
  }

  /**
   * 获取所有可用工具（包含冲突处理）
   *
   * 工具命名策略：
   * - 无冲突: toolName
   * - 有冲突: serverName__toolName
   */
  async getAvailableTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    const nameConflicts = new Map<string, number>();

    // 第一遍：检测冲突
    for (const [_serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        for (const mcpTool of serverInfo.tools) {
          const count = nameConflicts.get(mcpTool.name) || 0;
          nameConflicts.set(mcpTool.name, count + 1);
        }
      }
    }

    // 第二遍：创建工具（冲突时添加前缀）
    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        for (const mcpTool of serverInfo.tools) {
          const hasConflict = (nameConflicts.get(mcpTool.name) || 0) > 1;
          const toolName = hasConflict
            ? `${serverName}__${mcpTool.name}`
            : mcpTool.name;

          const tool = createMcpTool(serverInfo.client, serverName, mcpTool, toolName);
          tools.push(tool);
        }
      }
    }

    return tools;
  }

  /**
   * 根据名称查找工具
   */
  async findTool(toolName: string): Promise<Tool | null> {
    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        const mcpTool = serverInfo.tools.find((tool) => tool.name === toolName);
        if (mcpTool) {
          return createMcpTool(serverInfo.client, serverName, mcpTool);
        }
      }
    }
    return null;
  }

  /**
   * 按服务器获取工具
   */
  getToolsByServer(serverName: string): Tool[] {
    const serverInfo = this.servers.get(serverName);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return [];
    }

    return serverInfo.tools.map((mcpTool) =>
      createMcpTool(serverInfo.client, serverName, mcpTool)
    );
  }

  /**
   * 获取服务器状态
   */
  getServerStatus(name: string): McpServerInfo | null {
    return this.servers.get(name) || null;
  }

  /**
   * 获取所有服务器信息
   */
  getAllServers(): Map<string, McpServerInfo> {
    return new Map(this.servers);
  }

  /**
   * 刷新所有服务器工具列表
   */
  async refreshAllTools(): Promise<void> {
    const refreshPromises: Promise<void>[] = [];

    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        refreshPromises.push(this.refreshServerTools(serverName));
      }
    }

    await Promise.allSettled(refreshPromises);
  }

  /**
   * 刷新指定服务器工具列表
   */
  async refreshServerTools(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return;
    }

    try {
      // 重新获取工具列表
      const newTools = serverInfo.client.availableTools;
      const oldToolsCount = serverInfo.tools.length;
      serverInfo.tools = newTools;

      this.emit('toolsUpdated', name, newTools, oldToolsCount);
    } catch (error) {
      console.warn(`刷新服务器 "${name}" 工具列表失败:`, error);
    }
  }

  /**
   * 设置客户端事件处理器
   */
  private setupClientEventHandlers(
    client: McpClient,
    serverInfo: McpServerInfo,
    name: string
  ): void {
    client.on('connected', (server) => {
      serverInfo.status = McpConnectionStatus.CONNECTED;
      serverInfo.connectedAt = new Date();
      serverInfo.tools = client.availableTools;
      this.emit('serverConnected', name, server);
    });

    client.on('disconnected', () => {
      serverInfo.status = McpConnectionStatus.DISCONNECTED;
      serverInfo.connectedAt = undefined;
      serverInfo.tools = [];
      this.emit('serverDisconnected', name);
    });

    client.on('error', (error) => {
      serverInfo.status = McpConnectionStatus.ERROR;
      serverInfo.lastError = error;
      this.emit('serverError', name, error);
    });

    client.on('toolsUpdated', (tools) => {
      const oldToolsCount = serverInfo.tools.length;
      serverInfo.tools = tools;
      this.emit('toolsUpdated', name, tools, oldToolsCount);
    });

    client.on('statusChanged', (newStatus, oldStatus) => {
      serverInfo.status = newStatus;
      this.emit('serverStatusChanged', name, newStatus, oldStatus);
    });
  }

  /**
   * 自动发现MCP服务器 (基础实现，可扩展)
   */
  async discoverServers(): Promise<McpServerInfo[]> {
    if (this.isDiscovering) {
      return Array.from(this.servers.values());
    }

    this.isDiscovering = true;
    this.emit('discoveryStarted');

    try {
      // 这里可以实现自动发现逻辑
      // 例如扫描常见的MCP服务器安装位置
      // 或者读取配置文件中的服务器列表

      // 目前返回已注册的服务器
      return Array.from(this.servers.values());
    } finally {
      this.isDiscovering = false;
      this.emit('discoveryCompleted');
    }
  }

  /**
   * 批量注册服务器
   */
  async registerServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const registrationPromises = Object.entries(servers).map(([name, config]) =>
      this.registerServer(name, config).catch((error) => {
        console.warn(`注册MCP服务器 "${name}" 失败:`, error);
        return error;
      })
    );

    await Promise.allSettled(registrationPromises);
  }

  /**
   * 获取统计信息
   */
  getStatistics() {
    let connectedCount = 0;
    let totalTools = 0;
    let errorCount = 0;

    for (const serverInfo of this.servers.values()) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        connectedCount++;
        totalTools += serverInfo.tools.length;
      } else if (serverInfo.status === McpConnectionStatus.ERROR) {
        errorCount++;
      }
    }

    return {
      totalServers: this.servers.size,
      connectedServers: connectedCount,
      errorServers: errorCount,
      totalTools,
      isDiscovering: this.isDiscovering,
    };
  }

  /**
   * 断开所有 MCP 服务器连接
   * 在应用退出时调用
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const [name, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        disconnectPromises.push(
          serverInfo.client.disconnect().catch((error) => {
            console.warn(`断开 MCP 服务器 "${name}" 时出错:`, error);
          })
        );
      }
    }

    await Promise.allSettled(disconnectPromises);
    this.servers.clear();
  }
}
