import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { BladeConfig } from '../../config/types/index.js';
import type { McpServer, McpConfig } from '../types.js';

export class McpConfigManager {
  private config: BladeConfig;
  private configPath: string;

  constructor(config: BladeConfig) {
    this.config = config;
    this.configPath = this.getDefaultConfigPath();
  }

  private getDefaultConfigPath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.blade', 'mcp-config.json');
  }

  public async initialize(): Promise<void> {
    // 确保配置目录存在
    const configDir = path.dirname(this.configPath);
    try {
      await fs.mkdir(configDir, { recursive: true });
    } catch (error) {
      // 忽略目录已存在的错误
    }

    console.log('MCP配置管理器初始化完成');
  }

  public async loadConfig(): Promise<McpConfig> {
    try {
      // 尝试从文件加载配置
      await fs.access(this.configPath);
      const content = await fs.readFile(this.configPath, 'utf-8');
      const fileConfig = JSON.parse(content);
      
      // 合并默认配置和文件配置
      return this.mergeConfig(this.getDefaultConfig(), fileConfig);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // 文件不存在，返回默认配置
        console.log('MCP配置文件不存在，使用默认配置');
        return this.getDefaultConfig();
      }
      
      console.error('加载MCP配置失败:', error);
      return this.getDefaultConfig();
    }
  }

  public async saveConfig(config: McpConfig): Promise<void> {
    try {
      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(this.configPath, content, 'utf-8');
      console.log(`MCP配置已保存: ${this.configPath}`);
    } catch (error) {
      console.error('保存MCP配置失败:', error);
      throw error;
    }
  }

  private getDefaultConfig(): McpConfig {
    return {
      enabled: true,
      servers: [],
      autoConnect: false,
      timeout: 30000,
      maxConnections: 10,
      defaultTransport: 'stdio',
      security: {
        validateCertificates: true,
        allowedOrigins: ['localhost'],
        maxMessageSize: 1024 * 1024, // 1MB
      },
      logging: {
        enabled: true,
        level: 'info',
        filePath: path.join(os.homedir(), '.blade', 'mcp.log'),
      },
      caching: {
        enabled: true,
        ttl: 300, // 5分钟
        maxSize: 1000,
      },
    };
  }

  private mergeConfig(defaultConfig: McpConfig, fileConfig: Partial<McpConfig>): McpConfig {
    return {
      ...defaultConfig,
      ...fileConfig,
      servers: this.mergeServers(defaultConfig.servers, fileConfig.servers || []),
      security: {
        ...defaultConfig.security,
        ...(fileConfig.security || {}),
      },
      logging: {
        ...defaultConfig.logging,
        ...(fileConfig.logging || {}),
      },
      caching: {
        ...defaultConfig.caching,
        ...(fileConfig.caching || {}),
      },
    };
  }

  private mergeServers(
    defaultServers: McpServer[],
    fileServers: Partial<McpServer>[]
  ): McpServer[] {
    const mergedServers = [...defaultServers];
    
    for (const fileServer of fileServers) {
      if (!fileServer.id) continue;
      
      const existingIndex = mergedServers.findIndex(s => s.id === fileServer.id);
      if (existingIndex >= 0) {
        // 合并现有服务器配置
        mergedServers[existingIndex] = {
          ...mergedServers[existingIndex],
          ...fileServer,
        };
      } else {
        // 添加新服务器
        mergedServers.push({
          id: fileServer.id,
          name: fileServer.name || fileServer.id,
          endpoint: fileServer.endpoint || '',
          transport: fileServer.transport || 'stdio',
          enabled: fileServer.enabled !== false,
          config: fileServer.config || {},
          capabilities: fileServer.capabilities || [],
          autoConnect: fileServer.autoConnect || false,
        } as McpServer);
      }
    }
    
    return mergedServers;
  }

  public async addServer(server: Omit<McpServer, 'id'> & { id?: string }): Promise<string> {
    const config = await this.loadConfig();
    
    // 生成服务器ID
    const serverId = server.id || this.generateServerId(server.name);
    
    // 检查是否已存在
    if (config.servers.some(s => s.id === serverId)) {
      throw new Error(`MCP服务器已存在: ${serverId}`);
    }
    
    // 添加服务器
    config.servers.push({
      id: serverId,
      name: server.name,
      endpoint: server.endpoint,
      transport: server.transport,
      enabled: server.enabled !== false,
      config: server.config || {},
      capabilities: server.capabilities || [],
      autoConnect: server.autoConnect || false,
    });
    
    // 保存配置
    await this.saveConfig(config);
    
    console.log(`添加MCP服务器: ${server.name} (${serverId})`);
    
    return serverId;
  }

  public async removeServer(serverId: string): Promise<void> {
    const config = await this.loadConfig();
    
    // 检查服务器是否存在
    const serverIndex = config.servers.findIndex(s => s.id === serverId);
    if (serverIndex < 0) {
      throw new Error(`MCP服务器未找到: ${serverId}`);
    }
    
    // 移除服务器
    const removedServer = config.servers.splice(serverIndex, 1)[0];
    
    // 保存配置
    await this.saveConfig(config);
    
    console.log(`移除MCP服务器: ${removedServer.name} (${serverId})`);
  }

  public async updateServer(serverId: string, updates: Partial<McpServer>): Promise<void> {
    const config = await this.loadConfig();
    
    // 查找服务器
    const serverIndex = config.servers.findIndex(s => s.id === serverId);
    if (serverIndex < 0) {
      throw new Error(`MCP服务器未找到: ${serverId}`);
    }
    
    // 更新服务器
    config.servers[serverIndex] = {
      ...config.servers[serverIndex],
      ...updates,
    };
    
    // 保存配置
    await this.saveConfig(config);
    
    console.log(`更新MCP服务器: ${serverId}`);
  }

  public async getServer(serverId: string): Promise<McpServer | undefined> {
    const config = await this.loadConfig();
    return config.servers.find(s => s.id === serverId);
  }

  public async getAllServers(): Promise<McpServer[]> {
    const config = await this.loadConfig();
    return config.servers;
  }

  public async enableServer(serverId: string): Promise<void> {
    await this.updateServer(serverId, { enabled: true });
  }

  public async disableServer(serverId: string): Promise<void> {
    await this.updateServer(serverId, { enabled: false });
  }

  public async setAutoConnect(serverId: string, autoConnect: boolean): Promise<void> {
    await this.updateServer(serverId, { autoConnect });
  }

  private generateServerId(name: string): string {
    // 基于名称生成唯一ID
    const baseId = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    // 添加时间戳确保唯一性
    return `${baseId}-${Date.now()}`;
  }

  public async backupConfig(backupPath: string): Promise<void> {
    try {
      await fs.copyFile(this.configPath, backupPath);
      console.log(`MCP配置备份已创建: ${backupPath}`);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        console.log('没有MCP配置需要备份');
      } else {
        console.error('MCP配置备份失败:', error);
        throw error;
      }
    }
  }

  public async restoreConfig(backupPath: string): Promise<void> {
    try {
      await fs.copyFile(backupPath, this.configPath);
      console.log(`MCP配置已从备份恢复: ${backupPath}`);
    } catch (error) {
      console.error('MCP配置恢复失败:', error);
      throw error;
    }
  }

  public async validateConfig(config: McpConfig): Promise<ConfigValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // 验证基本配置
    if (config.timeout && config.timeout < 1000) {
      warnings.push('超时时间过短，建议至少1000ms');
    }
    
    if (config.maxConnections && config.maxConnections > 100) {
      warnings.push('最大连接数过大，可能影响性能');
    }
    
    // 验证服务器配置
    for (const server of config.servers) {
      if (!server.endpoint) {
        errors.push(`服务器 ${server.name} 缺少端点配置`);
      }
      
      if (!['stdio', 'sse', 'websocket'].includes(server.transport)) {
        errors.push(`服务器 ${server.name} 使用不支持的传输类型: ${server.transport}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  public async migrateConfig(): Promise<void> {
    // 这里可以实现配置迁移逻辑
    // 暂时留空
    console.log('检查MCP配置迁移...');
  }
}

// 类型定义
interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}