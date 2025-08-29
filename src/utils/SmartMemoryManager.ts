/**
 * 智能内存管理器
 * 实现内存池、对象复用、泄漏检测和自动清理
 */

import { EventEmitter } from 'events';

// 内存池配置
interface MemoryPoolConfig {
  name: string;
  maxItems: number;
  initialItems: number;
  expandSize: number;
  shrinkThreshold: number;
  shrinkInterval: number; // 毫秒
}

// 对象工厂接口
interface ObjectFactory<T> {
  create: () => T;
  reset: (obj: T) => void;
  destroy?: (obj: T) => void;
}

// 内存使用统计
interface MemoryStats {
  totalAllocated: number;
  activeObjects: number;
  pooledObjects: number;
  totalMemory: number;
  peakMemory: number;
  gcCount: number;
  lastGCTime: number;
}

// 内存泄漏检测配置
interface LeakDetectionConfig {
  enabled: boolean;
  interval: number;
  threshold: number;
  maxTrackedObjects: number;
}

// 跟踪对象信息
interface TrackedObject {
  id: string;
  type: string;
  size: number;
  createTime: number;
  stackTrace?: string;
  refCount: number;
}

/**
 * 通用内存池类
 */
export class MemoryPool<T> {
  private pool: T[] = [];
  private active: Set<T> = new Set();
  private factory: ObjectFactory<T>;
  private config: MemoryPoolConfig;
  private stats: MemoryStats;
  private shrinkTimer?: NodeJS.Timeout;

  constructor(factory: ObjectFactory<T>, config: MemoryPoolConfig) {
    this.factory = factory;
    this.config = config;
    this.stats = {
      totalAllocated: 0,
      activeObjects: 0,
      pooledObjects: 0,
      totalMemory: 0,
      peakMemory: 0,
      gcCount: 0,
      lastGCTime: 0,
    };

    // 初始化池
    this.initialize();
    
    // 启动自动收缩定时器
    this.startAutoShrink();
  }

  private initialize() {
    for (let i = 0; i < this.config.initialItems; i++) {
      const obj = this.factory.create();
      this.pool.push(obj);
      this.stats.pooledObjects++;
      this.stats.totalAllocated++;
    }
  }

  acquire(): T {
    let obj: T;
    
    if (this.pool.length > 0) {
      obj = this.pool.pop()!;
      this.stats.pooledObjects--;
    } else {
      // 扩展池
      this.expand();
      obj = this.pool.pop()!;
      this.stats.pooledObjects--;
    }

    this.active.add(obj);
    this.stats.activeObjects++;
    
    return obj;
  }

  release(obj: T): void {
    if (!this.active.has(obj)) {
      return; // 不是当前活跃的对象
    }

    this.active.delete(obj);
    this.factory.reset(obj);
    
    if (this.pool.length < this.config.maxItems) {
      this.pool.push(obj);
      this.stats.pooledObjects++;
    } else {
      // 池已满，销毁对象
      if (this.factory.destroy) {
        this.factory.destroy(obj);
      }
    }
    
    this.stats.activeObjects--;
  }

  private expand(): void {
    const expandCount = Math.min(
      this.config.expandSize,
      this.config.maxItems - this.pool.length - this.active.size
    );

    for (let i = 0; i < expandCount; i++) {
      const obj = this.factory.create();
      this.pool.push(obj);
      this.stats.pooledObjects++;
      this.stats.totalAllocated++;
    }

    this.updateMemoryStats();
  }

  private shrink(): void {
    const shrinkCount = Math.max(
      0,
      this.pool.length - this.config.shrinkThreshold
    );

    if (shrinkCount > 0) {
      for (let i = 0; i < shrinkCount; i++) {
        const obj = this.pool.pop();
        if (obj && this.factory.destroy) {
          this.factory.destroy(obj);
        }
      }
      this.stats.pooledObjects -= shrinkCount;
    }
  }

  private startAutoShrink(): void {
    this.shrinkTimer = setInterval(() => {
      this.shrink();
      this.updateMemoryStats();
    }, this.config.shrinkInterval);
  }

  private updateMemoryStats(): void {
    const totalMemory = process.memoryUsage().heapUsed;
    this.stats.totalMemory = totalMemory;
    if (totalMemory > this.stats.peakMemory) {
      this.stats.peakMemory = totalMemory;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  destroy(): void {
    if (this.shrinkTimer) {
      clearInterval(this.shrinkTimer);
    }

    // 清理所有对象
    const allObjects = [...this.pool, ...this.active];
    allObjects.forEach(obj => {
      if (this.factory.destroy) {
        this.factory.destroy(obj);
      }
    });

    this.pool = [];
    this.active.clear();
  }
}

/**
 * 内存泄漏检测器
 */
export class MemoryLeakDetector extends EventEmitter {
  private trackedObjects: Map<string, TrackedObject> = new Map();
  private config: LeakDetectionConfig;
  private intervalId?: NodeJS.Timeout;
  private lastGCTime = 0;

  constructor(config: Partial<LeakDetectionConfig> = {}) {
    super();
    this.config = {
      enabled: true,
      interval: 30000, // 30秒
      threshold: 100, // 100个对象
      maxTrackedObjects: 10000,
      ...config,
    };

    if (this.config.enabled) {
      this.startDetection();
    }
  }

  private startDetection(): void {
    this.intervalId = setInterval(() => {
      this.detectLeaks();
    }, this.config.interval);
  }

  track(object: any, type: string, size = 0): string {
    if (!this.config.enabled) return '';
    
    const id = this.generateId();
    
    // 获取调用栈（仅用于调试）
    const stackTrace = this.config.enabled 
      ? new Error().stack?.split('\n').slice(3, 8).join('\n') 
      : undefined;

    const trackedObj: TrackedObject = {
      id,
      type,
      size,
      createTime: Date.now(),
      stackTrace,
      refCount: 1,
    };

    this.trackedObjects.set(id, trackedObj);

    // 限制最大跟踪数量
    if (this.trackedObjects.size > this.config.maxTrackedObjects) {
      const oldestId = this.trackedObjects.keys().next().value;
      this.trackedObjects.delete(oldestId);
    }

    return id;
  }

  untrack(id: string): void {
    const obj = this.trackedObjects.get(id);
    if (obj) {
      obj.refCount--;
      if (obj.refCount <= 0) {
        this.trackedObjects.delete(id);
      }
    }
  }

  private detectLeaks(): void {
    const now = Date.now();
    const gcEnabled = global.gc;
    
    // 如果可以，先触发GC
    if (gcEnabled && now - this.lastGCTime > 60000) {
      global.gc();
      this.lastGCTime = now;
    }

    const leakCandidates: TrackedObject[] = [];
    
    this.trackedObjects.forEach((obj) => {
      // 查找长时间存活的对象
      const age = now - obj.createTime;
      if (age > 60000 && obj.refCount > 0) { // 存活超过1分钟
        leakCandidates.push(obj);
      }
    });

    if (leakCandidates.length > this.config.threshold) {
      this.emit('leak detected', {
        count: leakCandidates.length,
        objects: leakCandidates.slice(0, 10), // 只报告前10个
        memoryUsage: process.memoryUsage(),
      });

      // 记录到控制台
      console.warn(`检测到可能的内存泄漏: ${leakCandidates.length} 个对象`);
      leakCandidates.slice(0, 5).forEach(obj => {
        console.warn(`- ${obj.type} (ID: ${obj.id}, 存活时间: ${(Date.now() - obj.createTime) / 1000}s)`);
        if (obj.stackTrace) {
          console.warn(`  创建堆栈:\n${obj.stackTrace}`);
        }
      });
    }

    this.emit('detection complete', {
      detected: leakCandidates.length,
      totalTracked: this.trackedObjects.size,
    });
  }

  private generateId(): string {
    return `obj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getLeakReport() {
    return {
      trackedObjects: this.trackedObjects.size,
      byType: this.groupByType(),
      oldestObjects: this.getOldestObjects(10),
    };
  }

  private groupByType() {
    const groups = new Map<string, number>();
    this.trackedObjects.forEach(obj => {
      groups.set(obj.type, (groups.get(obj.type) || 0) + 1);
    });
    return Object.fromEntries(groups);
  }

  private getOldestObjects(limit: number) {
    return Array.from(this.trackedObjects.values())
      .sort((a, b) => a.createTime - b.createTime)
      .slice(0, limit);
  }

  destroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.trackedObjects.clear();
    this.removeAllListeners();
  }
}

/**
 * 智能内存管理器
 */
export class SmartMemoryManager {
  private static instance: SmartMemoryManager;
  private pools = new Map<string, MemoryPool<any>>();
  private leakDetector: MemoryLeakDetector;
  private eventEmitter = new EventEmitter();
  private memoryThreshold: number;
  private lastGC = 0;
  private gcInterval = 60000; // 1分钟

  private constructor() {
    this.leakDetector = new MemoryLeakDetector({
      enabled: process.env.NODE_ENV === 'development',
      interval: 30000,
      threshold: 50,
    });

    this.memoryThreshold = 200 * 1024 * 1024; // 200MB

    // 监听内存泄漏事件
    this.leakDetector.on('leak detected', (report) => {
      this.eventEmitter.emit('leak detected', report);
    });

    // 启动定期内存检查
    this.startMemoryMonitoring();
  }

  static getInstance(): SmartMemoryManager {
    if (!SmartMemoryManager.instance) {
      SmartMemoryManager.instance = new SmartMemoryManager();
    }
    return SmartMemoryManager.instance;
  }

  /**
   * 创建内存池
   */
  createPool<T>(name: string, factory: ObjectFactory<T>, config: MemoryPoolConfig): MemoryPool<T> {
    const pool = new MemoryPool<T>(factory, config);
    this.pools.set(name, pool);
    return pool;
  }

  /**
   * 获取内存池
   */
  getPool<T>(name: string): MemoryPool<T> | undefined {
    return this.pools.get(name);
  }

  /**
   * 跟踪对象
   */
  track(object: any, type: string, size?: number): string {
    return this.leakDetector.track(object, type, size);
  }

  /**
   * 取消跟踪对象
   */
  untrack(id: string): void {
    this.leakDetector.untrack(id);
  }

  /**
   * 检查内存使用情况
   */
  checkMemoryUsage(): {
    usage: NodeJS.MemoryUsage;
    isOverThreshold: boolean;
    recommendation: string;
  } {
    const usage = process.memoryUsage();
    const isOverThreshold = usage.heapUsed > this.memoryThreshold;
    
    let recommendation = '内存使用正常';
    if (isOverThreshold) {
      recommendation = '建议执行垃圾回收';
      if (global.gc && Date.now() - this.lastGC > this.gcInterval) {
        global.gc();
        this.lastGC = Date.now();
        recommendation = '已执行垃圾回收';
      }
    }

    return {
      usage,
      isOverThreshold,
      recommendation,
    };
  }

  /**
   * 强制内存清理
   */
  forceCleanup(): void {
    // 清理所有内存池
    this.pools.forEach(pool => {
      pool.destroy();
    });
    this.pools.clear();

    // 清理泄漏检测器
    this.leakDetector.destroy();

    // 强制GC
    if (global.gc) {
      global.gc();
      this.lastGC = Date.now();
    }

    this.eventEmitter.emit('cleanup complete');
  }

  /**
   * 获取内存报告
   */
  getMemoryReport(): {
    usage: NodeJS.MemoryUsage;
    pools: Record<string, any>;
    leakDetection: any;
  } {
    const poolStats: Record<string, any> = {};
    this.pools.forEach((pool, name) => {
      poolStats[name] = pool.getStats();
    });

    return {
      usage: process.memoryUsage(),
      pools: poolStats,
      leakDetection: this.leakDetector.getLeakReport(),
    };
  }

  /**
   * 设置内存阈值
   */
  setMemoryThreshold(bytes: number): void {
    this.memoryThreshold = bytes;
  }

  /**
   * 监听内存事件
   */
  on(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }

  private startMemoryMonitoring(): void {
    setInterval(() => {
      const memCheck = this.checkMemoryUsage();
      if (memCheck.isOverThreshold) {
        console.warn(memCheck.recommendation);
      }
    }, 10000); // 每10秒检查一次
  }
}

// 导出单例实例
export const smartMemoryManager = SmartMemoryManager.getInstance();

// 常用的对象工厂
export const ObjectFactories = {
  // Buffer池
  bufferFactory: (size: number): ObjectFactory<Buffer> => ({
    create: () => Buffer.alloc(size),
    reset: (buffer) => buffer.fill(0),
    destroy: undefined, // Buffer会被自动回收
  }),

  // 数组池
  arrayFactory: <T>(initialSize = 0): ObjectFactory<T[]> => ({
    create: () => new Array(initialSize),
    reset: (array) => array.length = 0,
    destroy: undefined,
  }),

  // Map池
  mapFactory: <K, V>(): ObjectFactory<Map<K, V>> => ({
    create: () => new Map(),
    reset: (map) => map.clear(),
    destroy: undefined,
  }),

  // Set池
  setFactory: <T>(): ObjectFactory<Set<T>> => ({
    create: () => new Set(),
    reset: (set) => set.clear(),
    destroy: undefined,
  }),
};

// 内存使用装饰器
export function trackMemory(type: string, size?: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const manager = SmartMemoryManager.getInstance();

    descriptor.value = function (...args: any[]) {
      const obj = originalMethod.apply(this, args);
      const trackId = manager.track(obj, type, size);
      
      // 在对象销毁时自动取消跟踪
      if (obj && typeof obj === 'object') {
        const originalDestroy = obj.destroy;
        obj.destroy = function () {
          if (originalDestroy) originalDestroy.apply(this, arguments);
          manager.untrack(trackId);
        };
      }

      return obj;
    };

    return descriptor;
  };
}