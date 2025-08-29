/**
 * LLM请求缓存和并发优化管理器
 * 实现智能缓存、请求去重、连接池和流式处理优化
 */

import EventEmitter from 'events';
import LRU from 'lru-cache';

// LLM请求缓存配置
interface CacheConfig {
  maxSize: number;
  ttl: number; // 毫秒
  enableCompression: boolean;
  maxCacheKeyLength: number;
}

// 并发配置
interface ConcurrencyConfig {
  maxConcurrent: number;
  queueTimeout: number;
  priorityLevels: number;
}

// 连接池配置
interface ConnectionPoolConfig {
  maxConnections: number;
  minConnections: number;
  idleTimeout: number;
  acquireTimeout: number;
  retryConfig: {
    maxRetries: number;
    retryDelay: number;
    retryBackoff: number;
  };
}

// 缓存键类型
type CacheKey = string;

// 优先级队列项
interface QueueItem<T = any> {
  id: string;
  data: T;
  priority: number;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timestamp: number;
}

// 请求统计
interface RequestStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  averageResponseTime: number;
  concurrentRequests: number;
  queueLength: number;
}

/**
 * LLM缓存实现
 */
class LLMCache {
  private cache: LRU<CacheKey, { response: any; timestamp: number; size: number }>;
  private config: CacheConfig;
  private compressionEnabled: boolean;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: CacheConfig) {
    this.config = config;
    this.compressionEnabled = config.enableCompression;
    
    this.cache = new LRU({
      max: config.maxSize,
      ttl: config.ttl,
      updateAgeOnGet: false,
      // 简单的LRU淘汰策略
      dispose: (value, key) => {
        this.stats.evictions++;
        this.emit('evicted', { key, size: value.size });
      },
    });
  }

  private generateCacheKey(request: any): CacheKey {
    // 生成规范化的缓存键
    const normalized = {
      messages: request.messages.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
      model: request.modelName,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    };
    
    let key = JSON.stringify(normalized);
    
    // 限制缓存键长度
    if (key.length > this.config.maxCacheKeyLength) {
      key = key.substring(0, this.config.maxCacheKeyLength) + '...';
    }
    
    return key;
  }

  async get(request: any): Promise<any | null> {
    const key = this.generateCacheKey(request);
    const cached = this.cache.get(key);
    
    if (cached) {
      this.stats.hits++;
      this.emit('hit', { key, age: Date.now() - cached.timestamp });
      return cached.response;
    }
    
    this.stats.misses++;
    this.emit('miss', { key });
    return null;
  }

  async set(request: any, response: any): Promise<void> {
    const key = this.generateCacheKey(request);
    let serializedResponse = response;
    
    // 如果启用压缩，压缩响应
    if (this.compressionEnabled) {
      serializedResponse = await this.compressResponse(response);
    }
    
    // 计算大小（近似）
    const size = JSON.stringify(serializedResponse).length;
    
    this.cache.set(key, {
      response: serializedResponse,
      timestamp: Date.now(),
      size,
    });
    
    this.emit('set', { key, size });
  }

  private async compressResponse(response: any): Promise<any> {
    // 简单的压缩策略：去除不必要的空格
    if (typeof response === 'string') {
      return response.replace(/\s+/g, ' ').trim();
    }
    return response;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
    };
  }

  private emit(event: string, data: any): void {
    // 可以在这里添加事件发射逻辑
  }
}

/**
 * 优先级队列实现
 */
class PriorityRequestQueue {
  private queues: QueueItem[][] = [];
  private config: ConcurrencyConfig;
  private processing = new Set<string>();
  private stats = {
    queued: 0,
    processed: 0,
    rejected: 0,
  };

  constructor(config: ConcurrencyConfig) {
    this.config = config;
    // 初始化优先级队列
    for (let i = 0; i < config.priorityLevels; i++) {
      this.queues.push([]);
    }
  }

  async enqueue<T>(data: T, priority = 0): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.generateId();
      const item: QueueItem = {
        id,
        data,
        priority: Math.min(priority, this.config.priorityLevels - 1),
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.queues[priority].push(item);
      this.stats.queued++;

      // 检查超时
      const timeout = setTimeout(() => {
        this.removeItem(id);
        item.reject(new Error(`Request timed out after ${this.config.queueTimeout}ms`));
        this.stats.rejected++;
      }, this.config.queueTimeout);

      // 将超时ID存储在item中以便清理
      (item as any).timeoutId = timeout;
    });
  }

  dequeue(): QueueItem | null {
    // 从最高优先级开始查找
    for (let i = this.config.priorityLevels - 1; i >= 0; i--) {
      if (this.queues[i].length > 0) {
        const item = this.queues[i].shift()!;
        this.processing.add(item.id);
        
        // 清除超时定时器
        if ((item as any).timeoutId) {
          clearTimeout((item as any).timeoutId);
        }
        
        return item;
      }
    }
    return null;
  }

  dequeueBatch(): QueueItem[] {
    const batch: QueueItem[] = [];
    const batchSize = Math.min(
      this.config.maxConcurrent - this.processing.size,
      5 // 每次最多处理5个请求
    );

    for (let i = 0; i < batchSize; i++) {
      const item = this.dequeue();
      if (item) {
        batch.push(item);
      } else {
        break;
      }
    }

    return batch;
  }

  markProcessing(id: string, completed = true): void {
    if (completed) {
      this.processing.delete(id);
      this.stats.processed++;
    }
  }

  private removeItem(id: string): void {
    for (let i = 0; i < this.config.priorityLevels; i++) {
      const index = this.queues[i].findIndex(item => item.id === id);
      if (index !== -1) {
        this.queues[i].splice(index, 1);
        break;
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueSize: this.queues.reduce((sum, q) => sum + q.length, 0),
      processingSize: this.processing.size,
    };
  }

  private generateId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * HTTP连接池
 */
class HTTPConnectionPool extends EventEmitter {
  private config: ConnectionPoolConfig;
  private connections: any[] = [];
  private available: Set<any> = new Set();
  private pending: any[] = [];
  private stats = {
    created: 0,
    acquired: 0,
    released: 0,
    destroyed: 0,
    timeouts: 0,
  };

  constructor(config: ConnectionPoolConfig) {
    super();
    this.config = config;
    this.initialize();
  }

  private async initialize(): Promise<void> {
    // 创建初始连接
    for (let i = 0; i < this.config.minConnections; i++) {
      await this.createConnection();
    }

    // 启动连接管理定时器
    setInterval(() => this.maintainConnections(), 30000);
  }

  async acquire(): Promise<any> {
    return new Promise((resolve, reject) => {
      // 检查是否有可用连接
      if (this.available.size > 0) {
        const connection = this.available.values().next().value;
        this.available.delete(connection);
        this.stats.acquired++;
        resolve(connection);
        return;
      }

      // 检查是否可以创建新连接
      if (this.connections.length < this.config.maxConnections) {
        this.createConnection()
          .then(connection => {
            this.stats.acquired++;
            resolve(connection);
          })
          .catch(reject);
        return;
      }

      // 加入等待队列
      const request = { resolve, reject, timestamp: Date.now() };
      this.pending.push(request);

      // 设置超时
      setTimeout(() => {
        const index = this.pending.indexOf(request);
        if (index !== -1) {
          this.pending.splice(index, 1);
          this.stats.timeouts++;
          reject(new Error('Connection acquire timeout'));
        }
      }, this.config.acquireTimeout);
    });
  }

  release(connection: any): void {
    // 检查是否有等待的请求
    if (this.pending.length > 0) {
      const request = this.pending.shift()!;
      request.resolve(connection);
    } else {
      this.available.add(connection);
    }
    this.stats.released++;
  }

  private async createConnection(): Promise<any> {
    // 这里应该创建实际的HTTP连接
    // 为了示例，我们返回一个模拟连接对象
    const connection = {
      id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      created: Date.now(),
      lastUsed: Date.now(),
      active: true,
      // 模拟fetch方法
      fetch: this.createFetchMethod(),
    };

    this.connections.push(connection);
    this.stats.created++;
    
    this.emit('connection:created', connection);
    return connection;
  }

  private createFetchMethod(): (url: string, options: any) => Promise<Response> {
    return async (url: string, options: any) => {
      let lastError: Error | null = null;
      
      // 实现重试逻辑
      for (let attempt = 1; attempt <= this.config.retryConfig.maxRetries; attempt++) {
        try {
          // 使用AbortSignal支持超时
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          return response;
        } catch (error) {
          lastError = error as Error;
          
          // 如果是最后一次重试，抛出错误
          if (attempt === this.config.retryConfig.maxRetries) {
            break;
          }
          
          // 等待重试延迟
          const delay = this.config.retryConfig.retryDelay * 
                        Math.pow(this.config.retryConfig.retryBackoff, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      throw lastError || new Error('Unknown error');
    };
  }

  private async maintainConnections(): Promise<void> {
    const now = Date.now();
    
    // 清理空闲连接
    for (const connection of this.connections) {
      if (!connection.active) continue;
      
      if (!this.available.has(connection)) continue;
      
      if (now - connection.lastUsed > this.config.idleTimeout) {
        await this.destroyConnection(connection);
      }
    }

    // 确保最小连接数
    const activeConnections = this.connections.filter(c => c.active).length;
    const toCreate = Math.max(0, this.config.minConnections - activeConnections);
    
    for (let i = 0; i < toCreate; i++) {
      await this.createConnection();
    }
  }

  private async destroyConnection(connection: any): Promise<void> {
    connection.active = false;
    this.available.delete(connection);
    const index = this.connections.indexOf(connection);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }
    this.stats.destroyed++;
    this.emit('connection:destroyed', connection);
  }

  getStats() {
    return {
      ...this.stats,
      totalConnections: this.connections.length,
      availableConnections: this.available.size,
      pendingRequests: this.pending.length,
    };
  }
}

/**
 * LLM请求优化管理器
 */
export class LLMRequestOptimizer extends EventEmitter {
  private cache: LLMCache;
  private queue: PriorityRequestQueue;
  private connectionPool: HTTPConnectionPool;
  private stats: RequestStats;
  private processing = false;

  constructor(
    cacheConfig: CacheConfig,
    queueConfig: ConcurrencyConfig,
    poolConfig: ConnectionPoolConfig
  ) {
    super();
    
    this.cache = new LLMCache(cacheConfig);
    this.queue = new PriorityRequestQueue(queueConfig);
    this.connectionPool = new HTTPConnectionPool(poolConfig);
    
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      averageResponseTime: 0,
      concurrentRequests: 0,
      queueLength: 0,
    };
    
    this.startProcessing();
  }

  /**
   * 发送优化后的LLM请求
   */
  async send(request: any, options: {
    priority?: number;
    bypassCache?: boolean;
    stream?: boolean;
  } = {}): Promise<any> {
    const startTime = performance.now();
    this.stats.totalRequests++;
    
    // 检查缓存（除非指定绕过）
    if (!options.bypassCache) {
      const cached = await this.cache.get(request);
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
    }
    this.stats.cacheMisses++;
    
    // 排队处理
    return this.queue.enqueue(request, options.priority || 0);
  }

  /**
   * 流式LLM请求
   */
  async sendStream(request: any, onChunk: (chunk: any) => void, options: {
    priority?: number;
    bypassCache?: boolean;
  } = {}): Promise<void> {
    // 流式请求通常不支持缓存
    request.stream = true;
    
    return this.queue.enqueue({
      ...request,
      type: 'stream',
      onChunk,
    }, options.priority || 0);
  }

  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.processing) {
      const batch = this.queue.dequeueBatch();
      
      if (batch.length === 0) {
        // 没有请求需要处理，稍等
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }

      this.stats.concurrentRequests = batch.length;
      
      // 并发处理批次
      await Promise.allSettled(
        batch.map(item => this.processRequest(item))
      );
    }
  }

  private async processRequest(item: QueueItem): Promise<void> {
    try {
      if ((item.data as any).type === 'stream') {
        await this.processStreamRequest(item);
      } else {
        const response = await this.processNormalRequest(item);
        item.resolve(response);
      }
    } catch (error) {
      item.reject(error);
    } finally {
      this.queue.markProcessing(item.id);
    }
  }

  private async processNormalRequest(item: QueueItem): Promise<any> {
    const request = item.data;
    const startTime = performance.now();
    
    // 获取连接
    const connection = await this.connectionPool.acquire();
    
    try {
      // 构造请求
      const payload = {
        model: request.modelName,
        messages: request.messages,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 2048,
      };

      const response = await connection.fetch(request.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      const result = {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage,
        model: data.model,
      };

      // 缓存结果
      await this.cache.set(request, result);

      // 更新统计
      const responseTime = performance.now() - startTime;
      this.updateAverageResponseTime(responseTime);

      return result;
    } finally {
      this.connectionPool.release(connection);
    }
  }

  private async processStreamRequest(item: QueueItem): Promise<void> {
    const request = item.data;
    const startTime = performance.now();
    
    const connection = await this.connectionPool.acquire();
    
    try {
      const response = await connection.fetch(request.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelName,
          messages: request.messages,
          stream: true,
        }),
      });

      // 这里应该处理流式响应
      // 简化示例：直接解析
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          // 简单的chunk解码
          const chunk = new TextDecoder().decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                request.onChunk?.(data);
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
      }

      item.resolve({ success: true });
    } catch (error) {
      item.resolve({ success: false, error });
    } finally {
      this.connectionPool.release(connection);
      this.queue.markProcessing(item.id);
      
      // 更新统计
      const responseTime = performance.now() - startTime;
      this.updateAverageResponseTime(responseTime);
    }
  }

  private updateAverageResponseTime(responseTime: number): void {
    // 使用移动平均
    this.stats.averageResponseTime = 
      (this.stats.averageResponseTime * 0.9) + (responseTime * 0.1);
  }

  getStats(): {
    requestStats: RequestStats;
    cacheStats: any;
    queueStats: any;
    poolStats: any;
  } {
    return {
      requestStats: { ...this.stats },
      cacheStats: this.cache.getStats(),
      queueStats: this.queue.getStats(),
      poolStats: this.connectionPool.getStats(),
    };
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    this.processing = false;
    
    // 等待所有处理中的请求完成
    while (this.stats.concurrentRequests > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.emit('destroyed');
  }
}

// 默认配置
export const defaultConfig = {
  cache: {
    maxSize: 1000,
    ttl: 5 * 60 * 1000, // 5分钟
    enableCompression: true,
    maxCacheKeyLength: 1000,
  },
  concurrency: {
    maxConcurrent: 10,
    queueTimeout: 30000, // 30秒
    priorityLevels: 3,
  },
  pool: {
    maxConnections: 20,
    minConnections: 5,
    idleTimeout: 5 * 60 * 1000, // 5分钟
    acquireTimeout: 10000, // 10秒
    retryConfig: {
      maxRetries: 3,
      retryDelay: 1000,
      retryBackoff: 2,
    },
  },
};

// 导出工厂函数
export function createLLMRequestOptimizer() {
  return new LLMRequestOptimizer(
    defaultConfig.cache,
    defaultConfig.concurrency,
    defaultConfig.pool
  );
}