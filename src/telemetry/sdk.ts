import axios from 'axios';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import type { BladeConfig } from '../config/types/index.js';

/// <reference types="node" />

export class TelemetrySDK {
  private config: BladeConfig;
  private events: TelemetryEvent[] = [];
  private isInitialized = false;
  private flushInterval: any = null;
  private sessionId: string;
  private userId: string | null = null;
  private deviceId: string;

  constructor(config: BladeConfig) {
    this.config = config;
    this.sessionId = this.generateSessionId();
    this.deviceId = this.getDeviceId();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // 检查是否启用遥测
    if (!this.config.services?.telemetry?.enabled) {
      console.log('遥测已禁用');
      return;
    }

    // 设置自动刷新
    const interval = 300000; // 5分钟
    this.flushInterval = setInterval(() => {
      this.flushEvents();
    }, interval);

    this.isInitialized = true;
    console.log('遥测SDK初始化完成');
  }

  // 设置用户ID
  public setUserId(userId: string): void {
    this.userId = userId;
  }

  // 记录事件
  public trackEvent(eventName: string, properties: Record<string, any> = {}): void {
    if (!this.isInitialized || !this.config.services?.telemetry?.enabled) {
      return;
    }

    const event: TelemetryEvent = {
      eventId: this.generateEventId(),
      eventName,
      properties: {
        ...properties,
        sessionId: this.sessionId,
        userId: this.userId,
        deviceId: this.deviceId,
      },
      timestamp: Date.now(),
      metadata: {
        version: this.config.version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    };

    this.events.push(event);

    // 检查是否需要立即刷新
    if (this.events.length >= 100) {
      this.flushEvents();
    }
  }

  // 记录页面浏览
  public trackPageView(pageName: string, properties: Record<string, any> = {}): void {
    this.trackEvent('page_view', {
      pageName,
      ...properties,
    });
  }

  // 记录错误
  public trackError(error: Error, properties: Record<string, any> = {}): void {
    this.trackEvent('error', {
      errorMessage: error.message,
      errorStack: error.stack,
      ...properties,
    });
  }

  // 记录性能指标
  public trackPerformance(
    metricName: string,
    value: number,
    properties: Record<string, any> = {}
  ): void {
    this.trackEvent('performance', {
      metricName,
      value,
      ...properties,
    });
  }

  // 记录用户行为
  public trackUserAction(
    action: string,
    target: string,
    properties: Record<string, any> = {}
  ): void {
    this.trackEvent('user_action', {
      action,
      target,
      ...properties,
    });
  }

  // 记录功能使用
  public trackFeatureUsage(
    feature: string,
    properties: Record<string, any> = {}
  ): void {
    this.trackEvent('feature_usage', {
      feature,
      ...properties,
    });
  }

  // 记录自定义指标
  public trackMetric(
    metricName: string,
    value: number,
    properties: Record<string, any> = {}
  ): void {
    this.trackEvent('custom_metric', {
      metricName,
      value,
      ...properties,
    });
  }

  // 刷新事件到服务器
  public async flushEvents(): Promise<void> {
    if (!this.isInitialized || this.events.length === 0) {
      return;
    }

    const eventsToSend = [...this.events];
    this.events = [];

    try {
      const payload: TelemetryPayload = {
        events: eventsToSend,
        batchId: this.generateBatchId(),
        timestamp: Date.now(),
      };

      await this.sendEvents(payload);
      console.log(`遥测事件已发送: ${eventsToSend.length} 个事件`);
    } catch (error) {
      console.error('发送遥测事件失败:', error);
      // 重新添加事件到队列
      this.events.unshift(...eventsToSend);
    }
  }

  // 发送事件到服务器
  private async sendEvents(payload: TelemetryPayload): Promise<void> {
    const endpoint =
      this.config.services?.telemetry?.endpoint || 'https://telemetry.blade-ai.com/api/v1/events';

    await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Blade-AI/${this.config.version}`,
      },
      timeout: 10000, // 10秒超时
    });
  }

  // 获取设备ID
  private getDeviceId(): string {
    // 基于机器信息生成设备ID
    const machineInfo = [
      process.platform,
      process.arch,
      process.env.USER || process.env.USERNAME || 'unknown',
    ].join('-');

    return createHash('sha256').update(machineInfo).digest('hex');
  }

  // 生成会话ID
  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 生成事件ID
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 生成批次ID
  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 性能监控装饰器
  public performanceMonitor(metricName: string) {
    return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
      const originalMethod = descriptor.value;

      descriptor.value = async function (...args: any[]) {
        const startTime = performance.now();

        try {
          const result = await originalMethod.apply(this, args);
          const duration = performance.now() - startTime;

          // 记录性能指标到性能监控器
          const monitor = PerformanceMonitor.getInstance();
          monitor.recordMetric(metricName, duration);

          return result;
        } catch (error) {
          const duration = performance.now() - startTime;

          // 记录性能指标和错误
          const monitor = PerformanceMonitor.getInstance();
          monitor.recordMetric(metricName, duration);

          throw error;
        }
      };

      return descriptor;
    };
  }

  // 获取遥测状态
  public getTelemetryStatus(): TelemetryStatus {
    return {
      enabled: this.config.services?.telemetry?.enabled || false,
      initialized: this.isInitialized,
      queuedEvents: this.events.length,
      sessionId: this.sessionId,
      userId: this.userId,
      deviceId: this.deviceId,
    };
  }

  // 获取事件统计
  public getEventStats(): EventStats {
    const eventTypes: Record<string, number> = {};

    for (const event of this.events) {
      eventTypes[event.eventName] = (eventTypes[event.eventName] || 0) + 1;
    }

    return {
      totalEvents: this.events.length,
      eventTypes,
      queuedEvents: this.events.length,
    };
  }

  // 清理事件队列
  public clearEvents(): void {
    this.events = [];
    console.log('遥测事件队列已清理');
  }

  // 销毁遥测SDK
  public async destroy(): Promise<void> {
    // 刷新所有待处理事件
    await this.flushEvents();

    // 清理定时器
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.isInitialized = false;
    this.events = [];

    console.log('遥测SDK已销毁');
  }

  // 静态方法：创建遥测实例
  public static async create(config: BladeConfig): Promise<TelemetrySDK> {
    const sdk = new TelemetrySDK(config);
    await sdk.initialize();
    return sdk;
  }
}

// 性能监控器
export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: Map<string, PerformanceMetric[]> = new Map();
  private startTime: number;

  private constructor() {
    this.startTime = performance.now();
  }

  public static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  // 开始测量
  public startMeasurement(name: string): string {
    const measurementId = `meas_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metric: PerformanceMetric = {
      id: measurementId,
      name,
      startTime: performance.now(),
      endTime: 0,
      duration: 0,
    };

    this.metrics.get(name)!.push(metric);

    return measurementId;
  }

  // 结束测量
  public endMeasurement(measurementId: string): number {
    for (const [, metrics] of this.metrics.entries()) {
      const metric = metrics.find((m) => m.id === measurementId);
      if (metric) {
        metric.endTime = performance.now();
        metric.duration = metric.endTime - metric.startTime;
        return metric.duration;
      }
    }

    throw new Error(`测量未找到: ${measurementId}`);
  }

  // 直接测量函数执行时间
  public async measureAsync<T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;

    this.recordMetric(name, duration);

    return { result, duration };
  }

  // 直接测量函数执行时间（同步）
  public measureSync<T>(name: string, fn: () => T): { result: T; duration: number } {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;

    this.recordMetric(name, duration);

    return { result, duration };
  }

  // 记录指标
  public recordMetric(name: string, duration: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metric: PerformanceMetric = {
      id: `meas_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      startTime: 0,
      endTime: 0,
      duration,
    };

    this.metrics.get(name)!.push(metric);
  }

  // 获取指标统计
  public getMetricsStats(name?: string): MetricStats {
    const metrics = name
      ? this.metrics.get(name) || []
      : Array.from(this.metrics.values()).flat();

    if (metrics.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        avg: 0,
        total: 0,
      };
    }

    const durations = metrics.map((m) => m.duration);
    const total = durations.reduce((sum, d) => sum + d, 0);

    return {
      count: metrics.length,
      min: Math.min(...durations),
      max: Math.max(...durations),
      avg: total / metrics.length,
      total,
    };
  }

  // 获取所有指标
  public getAllMetrics(): Record<string, MetricStats> {
    const stats: Record<string, MetricStats> = {};

    for (const [name] of this.metrics.entries()) {
      stats[name] = this.getMetricsStats(name);
    }

    return stats;
  }

  // 清理指标
  public clearMetrics(name?: string): void {
    if (name) {
      this.metrics.delete(name);
    } else {
      this.metrics.clear();
    }
  }

  // 获取运行时间
  public getUptime(): number {
    return performance.now() - this.startTime;
  }
}

// 错误追踪器
export class ErrorTracker {
  private static instance: ErrorTracker;
  private errors: TrackedError[] = [];
  private telemetrySDK: TelemetrySDK | null = null;

  private constructor() {}

  public static getInstance(): ErrorTracker {
    if (!ErrorTracker.instance) {
      ErrorTracker.instance = new ErrorTracker();
    }
    return ErrorTracker.instance;
  }

  public setTelemetrySDK(sdk: TelemetrySDK): void {
    this.telemetrySDK = sdk;
  }

  public trackError(error: Error, context?: ErrorContext): void {
    const trackedError: TrackedError = {
      id: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      context: context || {},
      timestamp: Date.now(),
      severity: context?.severity || 'error',
    };

    this.errors.push(trackedError);

    // 发送到遥测系统
    if (this.telemetrySDK) {
      this.telemetrySDK.trackError(error, {
        errorId: trackedError.id,
        context: context,
        severity: trackedError.severity,
      });
    }

    console.error('追踪到错误:', trackedError);
  }

  public getErrors(limit?: number): TrackedError[] {
    const errors = [...this.errors].reverse();
    return limit ? errors.slice(0, limit) : errors;
  }

  public getErrorStats(): ErrorStats {
    const severityCounts: Record<string, number> = {};

    for (const error of this.errors) {
      severityCounts[error.severity] = (severityCounts[error.severity] || 0) + 1;
    }

    return {
      totalErrors: this.errors.length,
      severityCounts,
      latestError: this.errors.length > 0 ? this.errors[this.errors.length - 1] : null,
    };
  }

  public clearErrors(): void {
    this.errors = [];
  }
}

// 类型定义
export interface TelemetryEvent {
  eventId: string;
  eventName: string;
  properties: Record<string, any>;
  timestamp: number;
  metadata: Record<string, any>;
}

export interface TelemetryPayload {
  events: TelemetryEvent[];
  batchId: string;
  timestamp: number;
}

export interface TelemetryStatus {
  enabled: boolean;
  initialized: boolean;
  queuedEvents: number;
  sessionId: string;
  userId: string | null;
  deviceId: string;
}

interface EventStats {
  totalEvents: number;
  eventTypes: Record<string, number>;
  queuedEvents: number;
}

interface PerformanceMetric {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
}

interface MetricStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  total: number;
}

interface TrackedError {
  id: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  context: Record<string, any>;
  timestamp: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

interface ErrorContext {
  component?: string;
  action?: string;
  userId?: string;
  sessionId?: string;
  [key: string]: any;
  severity?: 'info' | 'warning' | 'error' | 'critical';
}

interface ErrorStats {
  totalErrors: number;
  severityCounts: Record<string, number>;
  latestError: TrackedError | null;
}
