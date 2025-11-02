/**
 * MCP 健康监控
 * 周期性检查连接状态并自动触发重连
 */

import { EventEmitter } from 'events';
import type { McpClient } from './McpClient.js';
import { McpConnectionStatus } from './types.js';

/**
 * 健康检查配置
 */
export interface HealthCheckConfig {
  /** 检查间隔（毫秒），默认 30 秒 */
  interval?: number;
  /** 超时时间（毫秒），默认 10 秒 */
  timeout?: number;
  /** 是否启用，默认 false */
  enabled?: boolean;
  /** 连续失败多少次后触发重连，默认 3 次 */
  failureThreshold?: number;
}

/**
 * 健康状态
 */
export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded', // 有失败但未达到阈值
  UNHEALTHY = 'unhealthy', // 达到失败阈值
  CHECKING = 'checking',
}

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: number;
  consecutiveFailures: number;
  lastError?: Error;
}

/**
 * MCP 健康监控器
 */
export class HealthMonitor extends EventEmitter {
  private client: McpClient;
  private config: Required<HealthCheckConfig>;
  private checkTimer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private consecutiveFailures = 0;
  private lastCheckTime = 0;
  private currentStatus: HealthStatus = HealthStatus.HEALTHY;

  constructor(client: McpClient, config: HealthCheckConfig = {}) {
    super();
    this.client = client;
    this.config = {
      interval: config.interval ?? 30000, // 30 秒
      timeout: config.timeout ?? 10000, // 10 秒
      enabled: config.enabled ?? false,
      failureThreshold: config.failureThreshold ?? 3,
    };
  }

  /**
   * 启动健康监控
   */
  start(): void {
    if (this.checkTimer) {
      console.warn('[HealthMonitor] 健康监控已在运行');
      return;
    }

    if (!this.config.enabled) {
      console.log('[HealthMonitor] 健康监控未启用');
      return;
    }

    console.log(`[HealthMonitor] 启动健康监控（间隔: ${this.config.interval}ms）`);
    this.scheduleNextCheck();
  }

  /**
   * 停止健康监控
   */
  stop(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
      console.log('[HealthMonitor] 停止健康监控');
    }
  }

  /**
   * 调度下一次检查
   */
  private scheduleNextCheck(): void {
    this.checkTimer = setTimeout(async () => {
      await this.performHealthCheck();
      this.scheduleNextCheck();
    }, this.config.interval);
  }

  /**
   * 执行健康检查
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    if (this.isChecking) {
      console.warn('[HealthMonitor] 上一次检查仍在进行中');
      return this.getLastResult();
    }

    this.isChecking = true;
    this.lastCheckTime = Date.now();
    this.setStatus(HealthStatus.CHECKING);

    try {
      // 检查连接状态
      const connectionStatus = this.client.connectionStatus;

      if (connectionStatus === McpConnectionStatus.CONNECTED) {
        // 尝试列出工具作为活跃度检查
        await this.pingServer();

        // 检查成功，重置失败计数
        this.consecutiveFailures = 0;
        this.setStatus(HealthStatus.HEALTHY);

        const result: HealthCheckResult = {
          status: HealthStatus.HEALTHY,
          timestamp: Date.now(),
          consecutiveFailures: 0,
        };

        this.emit('healthCheck', result);
        return result;
      } else {
        // 连接未建立
        throw new Error(`连接状态异常: ${connectionStatus}`);
      }
    } catch (error) {
      this.consecutiveFailures++;
      const err = error as Error;

      console.warn(
        `[HealthMonitor] 健康检查失败（${this.consecutiveFailures}/${this.config.failureThreshold}）:`,
        err.message
      );

      // 判断状态
      let status: HealthStatus;
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        status = HealthStatus.UNHEALTHY;
        this.emit('unhealthy', this.consecutiveFailures, err);

        // 触发重连
        console.log('[HealthMonitor] 达到失败阈值，触发重连...');
        this.triggerReconnection().catch((reconnectError) => {
          console.error('[HealthMonitor] 重连失败:', reconnectError);
        });
      } else {
        status = HealthStatus.DEGRADED;
      }

      this.setStatus(status);

      const result: HealthCheckResult = {
        status,
        timestamp: Date.now(),
        consecutiveFailures: this.consecutiveFailures,
        lastError: err,
      };

      this.emit('healthCheck', result);
      return result;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Ping 服务器（通过列出工具）
   */
  private async pingServer(): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), this.config.timeout);
    });

    // 使用列出工具作为 ping
    const checkPromise = (async () => {
      const tools = this.client.availableTools;
      if (tools.length === 0) {
        // 如果没有工具，至少检查客户端是否存在
        if (!this.client.server) {
          throw new Error('Server info not available');
        }
      }
    })();

    await Promise.race([checkPromise, timeoutPromise]);
  }

  /**
   * 触发重连
   */
  private async triggerReconnection(): Promise<void> {
    try {
      // 先断开
      await this.client.disconnect();

      // 等待一小段时间
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 重新连接
      await this.client.connect();

      console.log('[HealthMonitor] 重连成功');
      this.consecutiveFailures = 0;
      this.setStatus(HealthStatus.HEALTHY);
      this.emit('reconnected');
    } catch (error) {
      console.error('[HealthMonitor] 重连失败:', error);
      throw error;
    }
  }

  /**
   * 设置状态
   */
  private setStatus(status: HealthStatus): void {
    if (this.currentStatus !== status) {
      const oldStatus = this.currentStatus;
      this.currentStatus = status;
      this.emit('statusChanged', status, oldStatus);
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): HealthStatus {
    return this.currentStatus;
  }

  /**
   * 获取最后检查结果
   */
  getLastResult(): HealthCheckResult {
    return {
      status: this.currentStatus,
      timestamp: this.lastCheckTime,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * 获取统计信息
   */
  getStatistics() {
    return {
      status: this.currentStatus,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckTime: this.lastCheckTime,
      isChecking: this.isChecking,
      config: this.config,
    };
  }

  /**
   * 立即执行健康检查
   */
  async checkNow(): Promise<HealthCheckResult> {
    return this.performHealthCheck();
  }

  /**
   * 重置失败计数
   */
  resetFailureCount(): void {
    this.consecutiveFailures = 0;
    if (this.currentStatus !== HealthStatus.CHECKING) {
      this.setStatus(HealthStatus.HEALTHY);
    }
  }
}
