/**
 * MCP 客户端（SDK 版本 + 增强功能）
 * 使用官方 @modelcontextprotocol/sdk
 * 支持重试、自动重连、错误分类、OAuth 认证、健康监控
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EventEmitter } from 'events';
import type { McpServerConfig } from '../config/types.js';
import { getPackageName, getVersion } from '../utils/packageInfo.js';
import { OAuthProvider } from './auth/index.js';
import { type HealthCheckConfig, HealthMonitor } from './HealthMonitor.js';
import {
  McpConnectionStatus,
  type McpToolCallResponse,
  type McpToolDefinition,
} from './types.js';

/**
 * 错误类型枚举
 */
export enum ErrorType {
  NETWORK_TEMPORARY = 'network_temporary', // 临时网络错误（可重试）
  NETWORK_PERMANENT = 'network_permanent', // 永久网络错误
  CONFIG_ERROR = 'config_error', // 配置错误
  AUTH_ERROR = 'auth_error', // 认证错误
  PROTOCOL_ERROR = 'protocol_error', // 协议错误
  UNKNOWN = 'unknown', // 未知错误
}

/**
 * 分类后的错误
 */
interface ClassifiedError {
  type: ErrorType;
  isRetryable: boolean;
  originalError: Error;
}

/**
 * 错误分类函数
 */
function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof Error)) {
    return {
      type: ErrorType.UNKNOWN,
      isRetryable: false,
      originalError: new Error(String(error)),
    };
  }

  const msg = error.message.toLowerCase();

  // 永久性配置错误（不应重试）
  const permanentErrors = [
    'command not found',
    'no such file',
    'permission denied',
    'invalid configuration',
    'malformed',
    'syntax error',
  ];

  if (permanentErrors.some((permanent) => msg.includes(permanent))) {
    return {
      type: ErrorType.CONFIG_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 认证错误（不应自动重试，需要用户介入）
  if (
    msg.includes('unauthorized') ||
    msg.includes('401') ||
    msg.includes('authentication failed')
  ) {
    return {
      type: ErrorType.AUTH_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 临时网络错误（可重试）
  const temporaryErrors = [
    'timeout',
    'connection refused',
    'network error',
    'temporary',
    'try again',
    'rate limit',
    'too many requests',
    'service unavailable',
    'socket hang up',
    'econnreset',
    'enotfound',
    'econnrefused',
    'etimedout',
    '503',
    '429',
  ];

  if (temporaryErrors.some((temporary) => msg.includes(temporary))) {
    return {
      type: ErrorType.NETWORK_TEMPORARY,
      isRetryable: true,
      originalError: error,
    };
  }

  // 默认视为临时错误（保守策略：允许重试）
  return {
    type: ErrorType.UNKNOWN,
    isRetryable: true,
    originalError: error,
  };
}

/**
 * MCP客户端
 */
export class McpClient extends EventEmitter {
  private status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED;
  private sdkClient: Client | null = null;
  private tools = new Map<string, McpToolDefinition>();
  private serverInfo: { name: string; version: string } | null = null;

  // 重连相关
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isManualDisconnect = false;

  // OAuth 支持
  private oauthProvider: OAuthProvider | null = null;
  private serverName: string;

  // 健康监控
  private healthMonitor: HealthMonitor | null = null;

  constructor(
    private config: McpServerConfig,
    serverName?: string,
    healthCheckConfig?: HealthCheckConfig
  ) {
    super();
    this.serverName = serverName || 'default';

    // 如果启用了 OAuth，初始化 provider
    if (config.oauth?.enabled) {
      this.oauthProvider = new OAuthProvider();
    }

    // 如果启用了健康监控，初始化 monitor
    if (healthCheckConfig?.enabled) {
      this.healthMonitor = new HealthMonitor(this, healthCheckConfig);

      // 转发健康监控事件
      this.healthMonitor.on('unhealthy', (failures, error) => {
        this.emit('unhealthy', failures, error);
      });

      this.healthMonitor.on('reconnected', () => {
        this.emit('healthMonitorReconnected');
      });
    }
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

  get healthCheck(): HealthMonitor | null {
    return this.healthMonitor;
  }

  /**
   * 连接到MCP服务器（带重试）
   */
  async connect(): Promise<void> {
    return this.connectWithRetry(3, 1000);
  }

  /**
   * 连接到MCP服务器（支持重试）
   * @param maxRetries 最大重试次数
   * @param initialDelay 初始延迟（毫秒）
   */
  async connectWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
    // 允许在 DISCONNECTED 或 ERROR 状态下重试连接
    // ERROR 状态可能是由于首次连接失败或意外断开导致的
    if (
      this.status !== McpConnectionStatus.DISCONNECTED &&
      this.status !== McpConnectionStatus.ERROR
    ) {
      throw new Error('客户端已连接或正在连接中');
    }

    // 如果是 ERROR 状态，先重置为 DISCONNECTED
    if (this.status === McpConnectionStatus.ERROR) {
      // 清理可能存在的旧连接
      if (this.sdkClient) {
        try {
          await this.sdkClient.close();
        } catch {
          // 忽略关闭错误
        }
        this.sdkClient = null;
      }
      this.setStatus(McpConnectionStatus.DISCONNECTED);
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.doConnect();
        this.reconnectAttempts = 0; // 重置重连计数
        return; // 成功连接
      } catch (error) {
        lastError = error as Error;
        const classified = classifyError(error);

        // 如果是永久性错误，不重试
        if (!classified.isRetryable) {
          console.error('[McpClient] 检测到永久性错误，放弃重试:', classified.type);
          throw error;
        }

        // 如果还有重试机会，等待后重试
        if (attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt - 1); // 指数退避
          console.warn(
            `[McpClient] 连接失败（${attempt}/${maxRetries}），${delay}ms 后重试...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 所有重试都失败
    throw lastError || new Error('连接失败');
  }

  /**
   * 实际连接逻辑（内部方法）
   */
  private async doConnect(): Promise<void> {
    try {
      this.setStatus(McpConnectionStatus.CONNECTING);

      // 创建 SDK 客户端
      this.sdkClient = new Client(
        {
          name: getPackageName(),
          version: getVersion(),
        },
        {
          capabilities: {
            roots: {
              listChanged: true,
            },
            sampling: {},
          },
        }
      );

      // 监听客户端关闭事件
      this.sdkClient.onclose = () => {
        this.handleUnexpectedClose();
      };

      // 创建传输层
      const transport = await this.createTransport();

      // 连接
      await this.sdkClient.connect(transport);

      // 获取服务器信息
      const serverVersion = this.sdkClient.getServerVersion();
      this.serverInfo = {
        name: serverVersion?.name || 'Unknown',
        version: serverVersion?.version || '0.0.0',
      };

      // 加载工具列表
      await this.loadTools();

      this.setStatus(McpConnectionStatus.CONNECTED);
      this.emit('connected', this.serverInfo);

      // 启动健康监控
      if (this.healthMonitor) {
        this.healthMonitor.start();
      }
    } catch (error) {
      this.setStatus(McpConnectionStatus.ERROR);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 处理意外断连
   */
  private handleUnexpectedClose(): void {
    if (this.isManualDisconnect) {
      // 手动断开，不重连
      return;
    }

    if (this.status === McpConnectionStatus.CONNECTED) {
      console.warn('[McpClient] 检测到意外断连，准备重连...');
      this.setStatus(McpConnectionStatus.ERROR);
      this.emit('error', new Error('MCP服务器连接意外关闭'));

      // 调度重连
      this.scheduleReconnect();
    }
  }

  /**
   * 调度自动重连
   */
  private scheduleReconnect(): void {
    // 清除之前的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('[McpClient] 达到最大重连次数，放弃重连');
      this.emit('reconnectFailed');
      return;
    }

    // 指数退避：1s, 2s, 4s, 8s, 16s（最大30s）
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(
      `[McpClient] 将在 ${delay}ms 后进行第 ${this.reconnectAttempts} 次重连...`
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        // 清理旧连接
        if (this.sdkClient) {
          try {
            await this.sdkClient.close();
          } catch {
            // 忽略关闭错误
          }
          this.sdkClient = null;
        }

        this.setStatus(McpConnectionStatus.DISCONNECTED);

        // 尝试重连
        await this.doConnect();
        console.log('[McpClient] 重连成功');
        this.reconnectAttempts = 0; // 重置计数
        this.emit('reconnected');
      } catch (error) {
        console.error('[McpClient] 重连失败:', error);
        const classified = classifyError(error);

        if (classified.isRetryable) {
          // 可重试错误，继续调度重连
          this.scheduleReconnect();
        } else {
          // 永久性错误，放弃重连
          console.error('[McpClient] 检测到永久性错误，停止重连');
          this.emit('reconnectFailed');
        }
      }
    }, delay);
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;

    // 停止健康监控
    if (this.healthMonitor) {
      this.healthMonitor.stop();
    }

    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sdkClient) {
      try {
        await this.sdkClient.close();
      } catch (error) {
        console.warn('[McpClient] 断开连接时出错:', error);
      }
      this.sdkClient = null;
    }

    this.tools.clear();
    this.serverInfo = null;
    this.reconnectAttempts = 0;
    this.setStatus(McpConnectionStatus.DISCONNECTED);
    this.emit('disconnected');

    this.isManualDisconnect = false;
  }

  /**
   * 调用MCP工具
   */
  async callTool(
    name: string,
    arguments_: Record<string, unknown> = {}
  ): Promise<McpToolCallResponse> {
    if (!this.sdkClient) {
      throw new Error('客户端未连接到服务器');
    }

    if (!this.tools.has(name)) {
      throw new Error(`工具 "${name}" 不存在`);
    }

    try {
      const result = await this.sdkClient.callTool({
        name,
        arguments: arguments_,
      });

      return result as McpToolCallResponse;
    } catch (error) {
      console.error(`[McpClient] 调用工具 "${name}" 失败:`, error);
      throw error;
    }
  }

  /**
   * 创建传输层（支持 OAuth）
   */
  private async createTransport(): Promise<Transport> {
    const { type, command, args, env, url, headers, oauth } = this.config;

    // 准备请求头（可能包含 OAuth 令牌）
    const finalHeaders = { ...headers };

    // 如果启用了 OAuth 且是 HTTP/SSE 传输
    if (oauth?.enabled && this.oauthProvider && (type === 'sse' || type === 'http')) {
      try {
        // 尝试获取有效令牌
        const token = await this.oauthProvider.getValidToken(this.serverName, oauth);

        if (!token) {
          // 没有令牌，需要认证
          console.log(`[McpClient] 服务器 "${this.serverName}" 需要 OAuth 认证`);
          const newToken = await this.oauthProvider.authenticate(
            this.serverName,
            oauth
          );
          finalHeaders['Authorization'] = `Bearer ${newToken.accessToken}`;
        } else {
          // 有有效令牌
          finalHeaders['Authorization'] = `Bearer ${token}`;
        }
      } catch (error) {
        console.error('[McpClient] OAuth 认证失败:', error);
        throw new Error(
          `OAuth 认证失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (type === 'stdio') {
      if (!command) {
        throw new Error('stdio 传输需要 command 参数');
      }
      // 过滤掉 undefined 值
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          processEnv[key] = value;
        }
      }
      return new StdioClientTransport({
        command,
        args: args || [],
        env: { ...processEnv, ...env },
        stderr: 'ignore', // 忽略子进程的 stderr 输出
      });
    } else if (type === 'sse') {
      if (!url) {
        throw new Error('sse 传输需要 url 参数');
      }
      return new SSEClientTransport(new URL(url), {
        requestInit: {
          headers: finalHeaders,
        },
      });
    } else if (type === 'http') {
      if (!url) {
        throw new Error('http 传输需要 url 参数');
      }
      // HTTP 传输需要动态导入
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: finalHeaders,
        },
      });
    }

    throw new Error(`不支持的传输类型: ${type}`);
  }

  /**
   * 加载工具列表
   */
  private async loadTools(): Promise<void> {
    if (!this.sdkClient) {
      return;
    }

    try {
      const response = await this.sdkClient.listTools();

      this.tools.clear();
      if (response.tools) {
        for (const tool of response.tools) {
          this.tools.set(tool.name, tool as McpToolDefinition);
        }
      }

      this.emit('toolsUpdated', this.availableTools);
    } catch (error) {
      console.error('[McpClient] 加载工具失败:', error);
      throw error;
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

  // ========================================
  // 兼容性方法（保持与 Registry 的接口一致）
  // ========================================

  async initialize(): Promise<void> {
    return this.connect();
  }

  async destroy(): Promise<void> {
    return this.disconnect();
  }

  async connectToServer(serverId?: string): Promise<void> {
    return this.connect();
  }

  async disconnectFromServer(serverId?: string): Promise<void> {
    return this.disconnect();
  }

  async listResources(serverId?: string): Promise<unknown[]> {
    if (!this.sdkClient) {
      return [];
    }
    try {
      const response = await this.sdkClient.listResources();
      return response.resources || [];
    } catch {
      return [];
    }
  }

  async listTools(serverId?: string): Promise<McpToolDefinition[]> {
    return this.availableTools;
  }

  async readResource(uri: string, serverId?: string): Promise<unknown> {
    if (!this.sdkClient) {
      throw new Error('客户端未连接');
    }
    const response = await this.sdkClient.readResource({ uri });
    return response.contents?.[0] || { uri, text: '' };
  }
}
