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

function boundedInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * MCP 健康监控器
 */
export class HealthMonitor extends EventEmitter {
  private client: McpClient;
  private config: Required<HealthCheckConfig>;
  private checkTimer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private running = false;
  private consecutiveFailures = 0;
  private lastCheckTime = 0;
  private currentStatus: HealthStatus = HealthStatus.HEALTHY;

  constructor(client: McpClient, config: HealthCheckConfig = {}) {
    super();
    this.client = client;
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      throw new Error('MCP health check enabled must be a boolean');
    }
    this.config = {
      interval: boundedInteger(
        config.interval,
        30_000,
        'MCP health check interval',
        10,
        5 * 60_000
      ),
      timeout: boundedInteger(
        config.timeout,
        10_000,
        'MCP health check timeout',
        10,
        60_000
      ),
      enabled: config.enabled ?? false,
      failureThreshold: boundedInteger(
        config.failureThreshold,
        3,
        'MCP health check failureThreshold',
        1,
        10
      ),
    };
  }

  /**
   * 启动健康监控
   */
  start(): void {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    this.scheduleNextCheck();
  }

  /**
   * 停止健康监控
   */
  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 调度下一次检查
   */
  private scheduleNextCheck(): void {
    if (!this.running) return;
    this.checkTimer = setTimeout(async () => {
      this.checkTimer = null;
      await this.performHealthCheck().catch(() => undefined);
      this.scheduleNextCheck();
    }, this.config.interval);
    this.checkTimer.unref();
  }

  /**
   * 执行健康检查
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    if (this.isChecking) {
      return this.getLastResult();
    }

    this.isChecking = true;
    this.lastCheckTime = Date.now();
    this.setStatus(HealthStatus.CHECKING);

    try {
      // 检查连接状态
      const connectionStatus = this.client.connectionStatus;

      if (connectionStatus === McpConnectionStatus.CONNECTED) {
        await this.client.ping(this.config.timeout);

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

      // 判断状态
      let status: HealthStatus;
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        status = HealthStatus.UNHEALTHY;
        this.emit('unhealthy', this.consecutiveFailures, err);
        this.client.requestRecovery(err, 'health_check');
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
