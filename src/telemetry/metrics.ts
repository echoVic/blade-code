import { performance } from 'perf_hooks';
import type { BladeConfig } from '../config/types/index.js';
import { TelemetrySDK } from './sdk.js';

export class MetricsCollector {
  private config: BladeConfig;
  private telemetrySDK: TelemetrySDK;
  private metrics: Map<string, Metric[]> = new Map();
  private collectionInterval: any = null;
  private isCollecting = false;

  constructor(config: BladeConfig, telemetrySDK: TelemetrySDK) {
    this.config = config;
    this.telemetrySDK = telemetrySDK;
  }

  public async initialize(): Promise<void> {
    if (this.isCollecting) {
      return;
    }

    // 设置定期收集
    const interval = 300000; // 5分钟
    this.collectionInterval = setInterval(() => {
      this.collectAndSendMetrics();
    }, interval);

    this.isCollecting = true;
    console.log('指标收集器初始化完成');
  }

  // 收集系统指标
  private async collectSystemMetrics(): Promise<SystemMetrics> {
    const startTime = performance.now();

    // 内存使用情况
    const memoryUsage = process.memoryUsage();

    // CPU使用情况
    const cpuUsage = process.cpuUsage();

    // 进程指标
    const processMetrics = {
      uptime: process.uptime(),
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      memoryUsage,
      cpuUsage,
    };

    // 收集时间
    const collectionTime = performance.now() - startTime;

    return {
      process: processMetrics,
      collectionTime,
      timestamp: Date.now(),
    };
  }

  // 收集应用指标
  private async collectApplicationMetrics(): Promise<ApplicationMetrics> {
    // 这里应该收集应用特定的指标
    // 暂时返回基础指标
    let appInfo: any = {};
    try {
      appInfo = require(process.cwd() + '/package.json') || {};
    } catch (error) {
      // 忽略错误，使用默认值
    }

    return {
      version: this.config.version || '1.0.0',
      name: appInfo.name || 'unknown',
      description: appInfo.description || '',
      startTime: Date.now() - process.uptime() * 1000,
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
  }

  // 收集网络指标
  private async collectNetworkMetrics(): Promise<NetworkMetrics> {
    // 这里应该收集网络相关指标
    // 暂时返回空指标

    return {
      requests: 0,
      errors: 0,
      avgResponseTime: 0,
      throughput: 0,
      timestamp: Date.now(),
    };
  }

  // 收集自定义指标
  public recordCustomMetric(
    name: string,
    value: number,
    tags: Record<string, string> = {}
  ): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metric: Metric = {
      name,
      value,
      tags,
      timestamp: Date.now(),
    };

    this.metrics.get(name)!.push(metric);

    // 发送到遥测系统
    this.telemetrySDK.trackMetric(name, value, tags);
  }

  // 增加计数器
  public incrementCounter(name: string, tags: Record<string, string> = {}): void {
    this.recordCustomMetric(name, 1, tags);
  }

  // 记录耗时
  public recordTiming(
    name: string,
    duration: number,
    tags: Record<string, string> = {}
  ): void {
    this.recordCustomMetric(`${name}.duration`, duration, tags);
  }

  // 记录直方图
  public recordHistogram(
    name: string,
    value: number,
    tags: Record<string, string> = {}
  ): void {
    this.recordCustomMetric(`${name}.histogram`, value, tags);
  }

  // 记录摘要
  public recordSummary(
    name: string,
    value: number,
    tags: Record<string, string> = {}
  ): void {
    this.recordCustomMetric(`${name}.summary`, value, tags);
  }

  // 收集并发送所有指标
  private async collectAndSendMetrics(): Promise<void> {
    try {
      const systemMetrics = await this.collectSystemMetrics();
      const appMetrics = await this.collectApplicationMetrics();
      const networkMetrics = await this.collectNetworkMetrics();

      // 发送系统指标
      this.sendSystemMetrics(systemMetrics);

      // 发送应用指标
      this.sendApplicationMetrics(appMetrics);

      // 发送网络指标
      this.sendNetworkMetrics(networkMetrics);

      // 发送自定义指标
      this.sendCustomMetrics();

      console.log('指标收集并发送完成');
    } catch (error) {
      console.error('指标收集失败:', error);
    }
  }

  private sendSystemMetrics(metrics: SystemMetrics): void {
    // 发送内存使用指标
    this.telemetrySDK.trackMetric('system.memory.rss', metrics.process.memoryUsage.rss);
    this.telemetrySDK.trackMetric(
      'system.memory.heapTotal',
      metrics.process.memoryUsage.heapTotal
    );
    this.telemetrySDK.trackMetric(
      'system.memory.heapUsed',
      metrics.process.memoryUsage.heapUsed
    );
    this.telemetrySDK.trackMetric(
      'system.memory.external',
      metrics.process.memoryUsage.external
    );

    // 发送CPU使用指标
    this.telemetrySDK.trackMetric('system.cpu.user', metrics.process.cpuUsage.user);
    this.telemetrySDK.trackMetric('system.cpu.system', metrics.process.cpuUsage.system);

    // 发送进程指标
    this.telemetrySDK.trackMetric('system.process.uptime', metrics.process.uptime);
    this.telemetrySDK.trackMetric('system.process.pid', metrics.process.pid);

    // 发送收集时间
    this.telemetrySDK.trackMetric(
      'system.metrics.collectionTime',
      metrics.collectionTime
    );
  }

  private sendApplicationMetrics(metrics: ApplicationMetrics): void {
    this.telemetrySDK.trackMetric('app.uptime', metrics.uptime);
    this.telemetrySDK.trackMetric('app.version', parseFloat(metrics.version) || 0);
  }

  private sendNetworkMetrics(metrics: NetworkMetrics): void {
    this.telemetrySDK.trackMetric('network.requests', metrics.requests);
    this.telemetrySDK.trackMetric('network.errors', metrics.errors);
    this.telemetrySDK.trackMetric('network.avgResponseTime', metrics.avgResponseTime);
    this.telemetrySDK.trackMetric('network.throughput', metrics.throughput);
  }

  private sendCustomMetrics(): void {
    for (const [name, metrics] of this.metrics.entries()) {
      // 发送最新的指标值
      if (metrics.length > 0) {
        const latestMetric = metrics[metrics.length - 1];
        this.telemetrySDK.trackMetric(name, latestMetric.value, latestMetric.tags);
      }
    }
  }

  // 获取指标统计
  public getMetricStats(name: string): MetricStats | null {
    const metrics = this.metrics.get(name);

    if (!metrics || metrics.length === 0) {
      return null;
    }

    const values = metrics.map((m) => m.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    return {
      count: metrics.length,
      sum,
      avg,
      min,
      max,
      latest: metrics[metrics.length - 1].value,
    };
  }

  // 获取所有指标统计
  public getAllMetricStats(): Record<string, MetricStats> {
    const stats: Record<string, MetricStats> = {};

    for (const name of this.metrics.keys()) {
      const metricStats = this.getMetricStats(name);
      if (metricStats) {
        stats[name] = metricStats;
      }
    }

    return stats;
  }

  // 清理旧指标
  public cleanupOldMetrics(olderThanMs: number = 3600000): void {
    // 1小时
    const cutoffTime = Date.now() - olderThanMs;

    for (const [name, metrics] of this.metrics.entries()) {
      const filteredMetrics = metrics.filter((m) => m.timestamp > cutoffTime);

      if (filteredMetrics.length === 0) {
        this.metrics.delete(name);
      } else {
        this.metrics.set(name, filteredMetrics);
      }
    }
  }

  // 重置指标
  public resetMetrics(name?: string): void {
    if (name) {
      this.metrics.delete(name);
    } else {
      this.metrics.clear();
    }
  }

  // 获取指标历史
  public getMetricHistory(name: string, limit?: number): Metric[] {
    const metrics = this.metrics.get(name) || [];
    const history = [...metrics].reverse();

    return limit ? history.slice(0, limit) : history;
  }

  public async destroy(): Promise<void> {
    // 发送最后的指标
    await this.collectAndSendMetrics();

    // 清理定时器
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }

    this.isCollecting = false;
    this.metrics.clear();

    console.log('指标收集器已销毁');
  }
}

// 日志收集器
export class LogCollector {
  private config: BladeConfig;
  private telemetrySDK: TelemetrySDK;
  private logs: CollectedLog[] = [];
  private maxLogs: number;

  constructor(config: BladeConfig, telemetrySDK: TelemetrySDK) {
    this.config = config;
    this.telemetrySDK = telemetrySDK;
    this.maxLogs = 1000; // 最多保存1000条日志
  }

  // 收集日志
  public collectLog(
    level: LogLevel,
    message: string,
    context: Record<string, any> = {}
  ): void {
    const log: CollectedLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      level,
      message,
      context,
      timestamp: Date.now(),
    };

    this.logs.push(log);

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // 根据配置决定是否发送到遥测系统
    if (this.shouldSendLog(level)) {
      this.telemetrySDK.trackEvent(`log.${level}`, {
        message,
        context,
        logId: log.id,
      });
    }
  }

  private shouldSendLog(level: LogLevel): boolean {
    const logLevel = this.config.services?.logging?.level || 'info';

    const levelPriority: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };

    return levelPriority[level] >= levelPriority[logLevel as LogLevel];
  }

  // 获取日志
  public getLogs(options?: LogFilterOptions): CollectedLog[] {
    let filteredLogs = [...this.logs];

    if (options?.level) {
      filteredLogs = filteredLogs.filter((log) => log.level === options.level);
    }

    if (options?.since) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp >= options.since!);
    }

    if (options?.until) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp <= options.until!);
    }

    if (options?.limit) {
      filteredLogs = filteredLogs.slice(-options.limit);
    }

    return filteredLogs;
  }

  // 搜索日志
  public searchLogs(query: string, options?: LogFilterOptions): CollectedLog[] {
    const logs = this.getLogs(options);
    return logs.filter(
      (log) =>
        log.message.toLowerCase().includes(query.toLowerCase()) ||
        JSON.stringify(log.context).toLowerCase().includes(query.toLowerCase())
    );
  }

  // 获取日志统计
  public getLogStats(): LogStats {
    const levelCounts: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };

    for (const log of this.logs) {
      levelCounts[log.level]++;
    }

    return {
      total: this.logs.length,
      levelCounts,
      latestLog: this.logs.length > 0 ? this.logs[this.logs.length - 1] : null,
    };
  }

  // 清理日志
  public clearLogs(): void {
    this.logs = [];
  }

  // 导出日志
  public exportLogs(format: LogExportFormat = 'json'): string {
    switch (format) {
      case 'json':
        return JSON.stringify(this.logs, null, 2);

      case 'text':
        return this.logs
          .map(
            (log) =>
              `[${new Date(log.timestamp).toISOString()}] ${log.level.toUpperCase()}: ${log.message}`
          )
          .join('\n');

      default:
        throw new Error(`不支持的日志导出格式: ${format}`);
    }
  }
}

// 类型定义
export interface Metric {
  name: string;
  value: number;
  tags: Record<string, string>;
  timestamp: number;
}

export interface MetricStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  latest: number;
}

export interface SystemMetrics {
  process: {
    uptime: number;
    pid: number;
    platform: string;
    arch: string;
    nodeVersion: string;
    memoryUsage: any;
    cpuUsage: any;
  };
  collectionTime: number;
  timestamp: number;
}

export interface ApplicationMetrics {
  version: string;
  name: string;
  description: string;
  startTime: number;
  uptime: number;
  timestamp: number;
}

interface NetworkMetrics {
  requests: number;
  errors: number;
  avgResponseTime: number;
  throughput: number;
  timestamp: number;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface CollectedLog {
  id: string;
  level: LogLevel;
  message: string;
  context: Record<string, any>;
  timestamp: number;
}

interface LogFilterOptions {
  level?: LogLevel;
  since?: number;
  until?: number;
  limit?: number;
}

interface LogStats {
  total: number;
  levelCounts: Record<LogLevel, number>;
  latestLog: CollectedLog | null;
}

type LogExportFormat = 'json' | 'text';
