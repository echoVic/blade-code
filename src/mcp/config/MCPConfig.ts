import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { MCPConnectionConfig } from '../types/mcp.js';

/**
 * MCP 配置管理
 */
export class MCPConfig {
  private configPath: string;
  private config!: MCPConfigFile;

  constructor(configPath?: string) {
    this.configPath = configPath || join(homedir(), '.blade', 'mcp-config.json');
    this.loadConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): void {
    if (existsSync(this.configPath)) {
      try {
        const content = readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(content);
      } catch (error) {
        console.warn('Failed to load MCP config, using defaults');
        this.config = this.getDefaultConfig();
      }
    } else {
      this.config = this.getDefaultConfig();
    }

    // 确保配置结构完整
    this.config = {
      ...this.getDefaultConfig(),
      ...this.config,
      servers: {
        ...this.getDefaultConfig().servers,
        ...this.config.servers,
      },
    };
  }

  /**
   * 保存配置
   */
  private saveConfig(): void {
    try {
      const dir = this.configPath.substring(0, this.configPath.lastIndexOf('/'));
      if (!existsSync(dir)) {
        const { mkdirSync } = require('fs');
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      throw new Error(`Failed to save MCP config: ${error}`);
    }
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): MCPConfigFile {
    return {
      servers: {},
      client: {
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000,
      },
      server: {
        port: 3001,
        host: 'localhost',
        transport: 'ws',
        auth: {
          enabled: false,
        },
      },
    };
  }

  /**
   * 添加服务器配置
   */
  addServer(name: string, config: MCPConnectionConfig): void {
    this.config.servers[name] = config;
    this.saveConfig();
  }

  /**
   * 移除服务器配置
   */
  removeServer(name: string): void {
    delete this.config.servers[name];
    this.saveConfig();
  }

  /**
   * 获取服务器配置
   */
  getServer(name: string): MCPConnectionConfig | undefined {
    return this.config.servers[name];
  }

  /**
   * 获取所有服务器配置
   */
  getServers(): Record<string, MCPConnectionConfig> {
    return this.config.servers;
  }

  /**
   * 更新客户端配置
   */
  updateClientConfig(config: Partial<MCPClientConfig>): void {
    this.config.client = {
      ...this.config.client,
      ...config,
    };
    this.saveConfig();
  }

  /**
   * 获取客户端配置
   */
  getClientConfig(): MCPClientConfig {
    return this.config.client;
  }

  /**
   * 更新服务器配置
   */
  updateServerConfig(config: Partial<MCPServerConfigFile>): void {
    this.config.server = {
      ...this.config.server,
      ...config,
    };
    this.saveConfig();
  }

  /**
   * 获取服务器配置
   */
  getServerConfig(): MCPServerConfigFile {
    return this.config.server;
  }

  /**
   * 验证服务器配置
   */
  validateServerConfig(config: MCPConnectionConfig): string[] {
    const errors: string[] = [];

    if (!config.name) {
      errors.push('Server name is required');
    }

    if (!config.transport) {
      errors.push('Transport type is required');
    }

    if (config.transport === 'ws' && !config.endpoint) {
      errors.push('WebSocket endpoint is required for ws transport');
    }

    if (config.transport === 'stdio' && !config.command) {
      errors.push('Command is required for stdio transport');
    }

    if (config.timeout && config.timeout < 1000) {
      errors.push('Timeout must be at least 1000ms');
    }

    return errors;
  }

  /**
   * 导出配置
   */
  exportConfig(): MCPConfigFile {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * 导入配置
   */
  importConfig(config: MCPConfigFile): void {
    this.config = {
      ...this.getDefaultConfig(),
      ...config,
      servers: {
        ...this.getDefaultConfig().servers,
        ...config.servers,
      },
    };
    this.saveConfig();
  }

  /**
   * 重置为默认配置
   */
  reset(): void {
    this.config = this.getDefaultConfig();
    this.saveConfig();
  }
}

/**
 * MCP 配置文件结构
 */
export interface MCPConfigFile {
  servers: Record<string, MCPConnectionConfig>;
  client: MCPClientConfig;
  server: MCPServerConfigFile;
}

/**
 * MCP 客户端配置
 */
export interface MCPClientConfig {
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}

/**
 * MCP 服务器配置文件
 */
export interface MCPServerConfigFile {
  port: number;
  host: string;
  transport: 'ws' | 'stdio';
  auth: {
    enabled: boolean;
    tokens?: string[];
  };
}

// 导出单例实例
export const mcpConfig = new MCPConfig();
