/**
 * 性能监控和调试系统
 * 提供实时性能指标、内存分析、性能追踪等功能
 */

import EventEmitter from 'events';
import { performance } from 'perf_hooks';
import { cpuUsage, memoryUsage } from 'node:process';

type CpuUsage = ReturnType<typeof cpuUsage>;
type MemoryUsage = ReturnType<typeof memoryUsage>;

// 性能指标数据结构
interface PerformanceMetrics {
  timestamp: number;
  cpuUsage: CpuUsage;
  memoryUsage: MemoryUsage;
  eventLoopDelay: number;
  activeHandles: number;
  activeRequests: number;
  gcStats: {
    total: number;
    major: number;
    minor: number;
    lastMajor: number;
    lastMinor: number;
  };
}

// 应用指标
interface ApplicationMetrics {
  requests: {
    total: number;
    successful: number;
    failed: number;
    averageResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
  };
  llm: {
    totalCalls: number;
    averageLatency: number;
    cacheHits: number;
    cacheMisses: number;
    errorRate: number;
  };
  resources: {
    fileDescriptors: number;
    socketConnections: number;
    timerCount: number;
  };
}

// 性能追踪配置
interface PerformanceTrace {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags: Map<string, string>;
  metadata: Record<string, any>;
  parent?: string;
  children: string[];
  category: 'request' | 'task' | 'gc' | 'http' | 'custom';
}

// 性能警告配置
interface PerformanceWarning {
  id: string;
  type: 'memory' | 'cpu' | 'event-loop' | 'requests' | 'gc';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  details?: Record<string, any>;
}

// 性能分析器配置
interface ProfilerConfig {
  enabled: boolean;
  interval: number;
  duration: number;
  maxTraces: number;
  maxWarnings: number;
  thresholds: {
    memory: number;
    cpu: number;
    eventLoopDelay: number;
    responseTime: number;
    gcFrequency: number;
  };
  reporting: {
    enabled: boolean;
    interval: number;
    format: 'console' | 'json' | 'prometheus';
    endpoint?: string;
  };
}

/**
 * 性能监控主类
 */
export class PerformanceMonitor extends EventEmitter {
  private metrics: PerformanceMetrics[] = [];
  private appMetrics: ApplicationMetrics;
  private traces: Map<string, PerformanceTrace> = new Map();
  private warnings: Set<PerformanceWarning> = new Set();
  private config: ProfilerConfig;
  private intervalId?: ReturnType<typeof setInterval>;
  private startTime: number;
  private gcStartTime: { major: number; minor: number } = { major: 0, minor: 0 };
  private lastCpuUsage: CpuUsage = { user: 0, system: 0 };

  constructor(config: Partial<ProfilerConfig> = {}) {
    super();
    this.startTime = performance.now();
    this.config = {
      enabled: true,
      interval: 1000, // 1秒
      duration: 0, // 持续运行
      maxTraces: 10000,
      maxWarnings: 100,
      thresholds: {
        memory: 500 * 1024 * 1024, // 500MB
        cpu: 80, // 80%
        eventLoopDelay: 100, // 100ms
        responseTime: 5000, // 5秒
        gcFrequency: 10, // 10次/分钟
      },
      reporting: {
        enabled: true,
        interval: 60000, // 1分钟
        format: 'console',
      },
      ...config,
    };

    this.appMetrics = {
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        maxResponseTime: 0,
        minResponseTime: Infinity,
      },
      llm: {
        totalCalls: 0,
        averageLatency: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errorRate: 0,
      },
      resources: {
        fileDescriptors: 0,
        socketConnections: 0,
        timerCount: 0,
      },
    };

    if (this.config.enabled) {
      this.start();
    }

    // 监听GC事件
    this.setupGCMonitoring();
  }

  /**
   * 启动监控
   */
  private start(): void {
    // 收集初始数据
    this.collectMetrics();

    // 设置定时收集
    this.intervalId = setInterval(() => {
      this.collectMetrics();
      this.analyzePerformance();
    }, this.config.interval);

    // 设置报告定时器
    if (this.config.reporting.enabled) {
      setInterval(() => {
        this.generateReport();
      }, this.config.reporting.interval);
    }
  }

  /**
   * 收集性能指标
   */
  private collectMetrics(): void {
    const timestamp = Date.now();
    const memUsage = process.memoryUsage();
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const eventLoopDelay = this.measureEventLoopDelay();
    
    // 计算CPU使用率
    const totalCpuDelta = currentCpuUsage.user + currentCpuUsage.system;
    const cpuUsagePercent = (totalCpuDelta / (1000 * this.config.interval)) * 100;
    
    const metrics: PerformanceMetrics = {
      timestamp,
      cpuUsage: currentCpuUsage,
      memoryUsage: memUsage,
      eventLoopDelay,
      activeHandles: (process as any)._getActiveHandles().length,
      activeRequests: (process as any)._getActiveRequests().length,
      gcStats: {
        total: 0, // 将在GCMonitoring中更新
        major: 0,
        minor: 0,
        lastMajor: 0,
        lastMinor: 0,
      },
    };

    this.metrics.push(metrics);
    this.lastCpuUsage = process.cpuUsage();
    
    // 检查CPU使用率阈值
    if (cpuUsagePercent > this.config.thresholds.cpu) {
      this.addWarning({
        id: `cpu-${timestamp}`,
        type: 'cpu',
        severity: 'warning',
        message: `High CPU usage detected: ${cpuUsagePercent.toFixed(2)}%`,
        value: cpuUsagePercent,
        threshold: this.config.thresholds.cpu,
        timestamp
      });
    }

    // 限制历史数据大小
    if (this.metrics.length > 3600) { // 保留1小时的数据
      this.metrics.shift();
    }

    this.emit('metrics:collected', metrics);
  }

  /**
   * 测量事件循环延迟
   */
  private measureEventLoopDelay(): number {
    const start = performance.now();
    
    const checkTime = () => {
      const end = performance.now();
      return end - start;
    };

    // 让事件循环执行一次
    setImmediate(() => {});
    
    return checkTime();
  }

  /**
   * 设置GC监控
   */
  private setupGCMonitoring(): void {
    if (global.gc) {
      const originalGC = global.gc;
      
      global.gc = () => {
        const startTime = performance.now();
        originalGC();
        const duration = performance.now() - startTime;
        
        // 更新GC统计
        if (duration > 100) { // 假设超过100ms是major GC
          this.gcStartTime.major++;
        } else {
          this.gcStartTime.minor++;
        }
        
        this.emit('gc:completed', {
          duration,
          type: duration > 100 ? 'major' : 'minor',
          timestamp: Date.now(),
        });
        
        return Promise.resolve();
      };
    }
    
    // 使用统计
    setInterval(() => {
      if (global.gc) {
        // 强制触发一次GC来获取统计（仅在开发环境）
        if (process.env.NODE_ENV === 'development' && Math.random() < 0.1) {
          global.gc();
        }
      }
    }, 60000);
  }

  /**
   * 分析性能数据
   */
  private analyzePerformance(): void {
    const latest = this.metrics[this.metrics.length - 1];
    if (!latest) return;

    // 内存警告
    if (latest.memoryUsage.heapUsed > this.config.thresholds.memory) {
      this.addWarning({
        id: `memory_${Date.now()}`,
        type: 'memory',
        severity: 'warning',
        message: `内存使用过高: ${(latest.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        value: latest.memoryUsage.heapUsed,
        threshold: this.config.thresholds.memory,
        timestamp: Date.now(),
        details: {
          heapTotal: latest.memoryUsage.heapTotal,
          external: latest.memoryUsage.external,
          rss: latest.memoryUsage.rss,
        },
      });
    }

    // 事件循环延迟警告
    if (latest.eventLoopDelay > this.config.thresholds.eventLoopDelay) {
      this.addWarning({
        id: `eventloop_${Date.now()}`,
        type: 'event-loop',
        severity: 'warning',
        message: `事件循环延迟过高: ${latest.eventLoopDelay.toFixed(2)}ms`,
        value: latest.eventLoopDelay,
        threshold: this.config.thresholds.eventLoopDelay,
        timestamp: Date.now(),
        details: {
          activeHandles: latest.activeHandles,
          activeRequests: latest.activeRequests,
        },
      });
    }

    // 请求响应时间警告
    if (this.appMetrics.requests.averageResponseTime > this.config.thresholds.responseTime) {
      this.addWarning({
        id: `response_time_${Date.now()}`,
        type: 'requests',
        severity: 'warning',
        message: `平均响应时间过长: ${this.appMetrics.requests.averageResponseTime.toFixed(2)}ms`,
        value: this.appMetrics.requests.averageResponseTime,
        threshold: this.config.thresholds.responseTime,
        timestamp: Date.now(),
        details: {
          totalRequests: this.appMetrics.requests.total,
          maxResponseTime: this.appMetrics.requests.maxResponseTime,
        },
      });
    }
  }

  /**
   * 添加性能警告
   */
  private addWarning(warning: PerformanceWarning): void {
    this.warnings.add(warning);
    this.emit('warning', warning);

    // 限制警告数量
    if (this.warnings.size > this.config.maxWarnings) {
      const oldestEntry = this.warnings.values().next();
      if (!oldestEntry.done && oldestEntry.value) {
        this.warnings.delete(oldestEntry.value);
      }
    }
  }

  /**
   * 记录请求
   */
  recordRequest(responseTime: number, success: boolean): void {
    this.appMetrics.requests.total++;
    
    if (success) {
      this.appMetrics.requests.successful++;
    } else {
      this.appMetrics.requests.failed++;
    }

    // 更新响应时间统计
    const totalResponseTime = this.appMetrics.requests.averageResponseTime * (this.appMetrics.requests.total - 1) + responseTime;
    this.appMetrics.requests.averageResponseTime = totalResponseTime / this.appMetrics.requests.total;

    if (responseTime > this.appMetrics.requests.maxResponseTime) {
      this.appMetrics.requests.maxResponseTime = responseTime;
    }
    
    if (responseTime < this.appMetrics.requests.minResponseTime) {
      this.appMetrics.requests.minResponseTime = responseTime;
    }

    this.emit('request:recorded', { responseTime, success });
  }

  /**
   * 记录LLM调用
   */
  recordLLMCall(latency: number, cacheHit: boolean, error: boolean): void {
    this.appMetrics.llm.totalCalls++;
    
    if (cacheHit) {
      this.appMetrics.llm.cacheHits++;
    } else {
      this.appMetrics.llm.cacheMisses++;
    }

    if (error) {
      // 更新错误率
      const totalCalls = this.appMetrics.llm.totalCalls;
      const errorCount = (this.appMetrics.llm.errorRate / 100) * (totalCalls - 1) + (error ? 1 : 0);
      this.appMetrics.llm.errorRate = (errorCount / totalCalls) * 100;
    }

    // 更新平均延迟
    const totalLatency = this.appMetrics.llm.averageLatency * (this.appMetrics.llm.totalCalls - 1) + latency;
    this.appMetrics.llm.averageLatency = totalLatency / this.appMetrics.llm.totalCalls;

    this.emit('llm:recorded', { latency, cacheHit, error });
  }

  /**
   * 开始性能追踪
   */
  startTrace(name: string, category: PerformanceTrace['category'], parentId?: string): string {
    const id = `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const trace: PerformanceTrace = {
      id,
      name,
      startTime: performance.now(),
      tags: new Map(),
      metadata: {},
      parent: parentId,
      children: [],
      category,
    };

    this.traces.set(id, trace);
    
    if (parentId) {
      const parentTrace = this.traces.get(parentId);
      if (parentTrace) {
        parentTrace.children.push(id);
      }
    }

    this.emit('trace:started', trace);
    
    return id;
  }

  /**
   * 结束性能追踪
   */
  endTrace(id: string, metadata?: Record<string, any>): number {
    const trace = this.traces.get(id);
    if (!trace) {
      return 0;
    }

    trace.endTime = performance.now();
    trace.duration = trace.endTime - trace.startTime;
    trace.metadata = { ...trace.metadata, ...metadata };

    this.traces.delete(id);
    this.emit('trace:completed', trace);

    return trace.duration;
  }

  /**
   * 生成性能报告
   */
  generateReport(): string | object {
    const latest = this.metrics[this.metrics.length - 1];
    const uptime = Date.now() - this.startTime;

    const report = {
      timestamp: Date.now(),
      uptime: {
        total: uptime,
        formatted: this.formatDuration(uptime),
      },
      system: {
        memoryUsage: latest ? {
          heapUsed: latest.memoryUsage.heapUsed,
          heapTotal: latest.memoryUsage.heapTotal,
          external: latest.memoryUsage.external,
          rss: latest.memoryUsage.rss,
          percentage: ((latest.memoryUsage.heapUsed / latest.memoryUsage.heapTotal) * 100).toFixed(2),
        } : null,
        eventLoopDelay: latest?.eventLoopDelay || 0,
        cpuUsage: latest ? {
          user: latest.cpuUsage.user,
          system: latest.cpuUsage.system,
        } : null,
      },
      application: this.appMetrics,
      warnings: Array.from(this.warnings).sort((a, b) => b.timestamp - a.timestamp),
      metricsCount: this.metrics.length,
      traceCount: this.traces.size,
    };

    if (this.config.reporting.format === 'json') {
      return JSON.stringify(report, null, 2);
    }

    this.emit('report:generated', report);
    
    return this.formatConsoleReport(report);
  }

  /**
   * 格式化控制台报告
   */
  private formatConsoleReport(report: any): string {
    return `
=== 性能监控报告 ===
运行时间: ${report.uptime.formatted}

内存使用:
  堆内存: ${report.system.memoryUsage ? (report.system.memoryUsage.heapUsed / 1024 / 1024).toFixed(2) + 'MB' : 'N/A'}
  使用率: ${report.system.memoryUsage?.percentage || 0}%
  RSS: ${report.system.memoryUsage ? (report.system.memoryUsage.rss / 1024 / 1024).toFixed(2) + 'MB' : 'N/A'}

事件循环延迟: ${report.system.eventLoopDelay.toFixed(2)}ms

请求统计:
  总请求数: ${report.application.requests.total}
  成功率: ${report.application.requests.total > 0 ? (report.application.requests.successful / report.application.requests.total * 100).toFixed(2) : 0}%
  平均响应时间: ${report.application.requests.averageResponseTime.toFixed(2)}ms
  最大响应时间: ${report.application.requests.maxResponseTime.toFixed(2)}ms

LLM调用统计:
  总调用数: ${report.application.llm.totalCalls}
  缓存命中率: ${report.application.llm.totalCalls > 0 ? (report.application.llm.cacheHits / report.application.llm.totalCalls * 100).toFixed(2) : 0}%
  平均延迟: ${report.application.llm.averageLatency.toFixed(2)}ms
  错误率: ${report.application.llm.errorRate.toFixed(2)}%

活动警告: ${report.warnings.length}
${report.warnings.slice(0, 5).map((w: any) => `  - ${w.type}: ${w.message}`).join('\n')}
=================
    `.trim();
  }

  /**
   * 格式化持续时间
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
    if (seconds % 60 > 0) parts.push(`${seconds % 60}s`);
    
    return parts.join(' ') || '0s';
  }

  /**
   * 获取性能快照
   */
  getSnapshot(): {
    metrics: PerformanceMetrics[];
    applicationMetrics: ApplicationMetrics;
    warnings: PerformanceWarning[];
    activeTraces: PerformanceTrace[];
  } {
    return {
      metrics: this.metrics,
      applicationMetrics: { ...this.appMetrics },
      warnings: Array.from(this.warnings),
      activeTraces: Array.from(this.traces.values()),
    };
  }

  /**
   * 重置统计信息
   */
  reset(): void {
    this.metrics = [];
    this.appMetrics = {
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        maxResponseTime: 0,
        minResponseTime: Infinity,
      },
      llm: {
        totalCalls: 0,
        averageLatency: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errorRate: 0,
      },
      resources: {
        fileDescriptors: 0,
        socketConnections: 0,
        timerCount: 0,
      },
    };
    this.warnings.clear();
    this.traces.clear();
    this.startTime = performance.now();

    this.emit('reset');
  }

  /**
   * 停止监控
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    
    this.emit('stopped');
  }

  /**
   * 销毁监控器
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}

// 导出单例实例
let monitorInstance: PerformanceMonitor | null = null;

export function getPerformanceMonitor(config?: Partial<ProfilerConfig>): PerformanceMonitor {
  if (!monitorInstance) {
    monitorInstance = new PerformanceMonitor(config);
  }
  return monitorInstance;
}

// 性能追踪装饰器
export function tracePerformance(category: PerformanceTrace['category'] = 'custom') {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const monitor = getPerformanceMonitor();

    descriptor.value = function (...args: any[]) {
      const traceId = monitor.startTrace(`${target.constructor.name}.${propertyKey}`, category);
      
      try {
        const result = originalMethod.apply(this, args);
        
        if (result instanceof Promise) {
          return result
            .then((res) => {
              monitor.endTrace(traceId);
              return res;
            })
            .catch((err) => {
              monitor.endTrace(traceId, { error: err.message });
              throw err;
            });
        } else {
          monitor.endTrace(traceId);
          return result;
        }
      } catch (error) {
        monitor.endTrace(traceId, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };

    return descriptor;
  };
}

// 导出工具函数
export const performanceUtils = {
  getPerformanceMonitor,
  tracePerformance,
  
  // 快速追踪函数
  async measure<T>(
    name: string, 
    fn: () => Promise<T> | T, 
    category: PerformanceTrace['category'] = 'custom'
  ): Promise<{ result: T; duration: number }> {
    const monitor = getPerformanceMonitor();
    const traceId = monitor.startTrace(name, category);
    
    try {
      const result = await fn();
      const duration = monitor.endTrace(traceId);
      return { result, duration };
    } catch (error) {
      monitor.endTrace(traceId, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
};