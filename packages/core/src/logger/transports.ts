import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import {
  LogEntry,
  LogTransport,
  LogFormatter,
  LogLevel,
  LogFilter,
  BaseTransport,
  JSONFormatter,
  TextFormatter,
  LogRotationConfig
} from './index.js';

/**
 * 轮转文件传输器
 */
export class RotatingFileTransport extends BaseTransport {
  public readonly name = 'rotating-file';
  
  private filePath: string;
  private rotationConfig: LogRotationConfig;
  private currentSize: number = 0;
  private lastRotationTime: Date = new Date();
  private writeFileQueue: string[] = [];
  private isWriting: boolean = false;

  constructor(
    filePath: string,
    rotationConfig: LogRotationConfig,
    formatter?: LogFormatter
  ) {
    super(formatter || new JSONFormatter());
    this.filePath = filePath;
    this.rotationConfig = rotationConfig;
  }

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    const logLine = typeof formatted === 'object' 
      ? JSON.stringify(formatted) + '\n'
      : formatted + '\n';

    // 检查是否需要轮转
    if (this.rotationConfig.enabled && this.shouldRotate()) {
      await this.rotateFile();
    }

    this.writeFileQueue.push(logLine);
    this.currentSize += logLine.length;
    await this.processWriteQueue();
  }

  private shouldRotate(): boolean {
    if (!this.rotationConfig.enabled) {
      return false;
    }

    const now = new Date();
    
    if (this.rotationConfig.strategy === 'size' || this.rotationConfig.strategy === 'hybrid') {
      if (this.currentSize >= (this.rotationConfig.maxSize || 10 * 1024 * 1024)) {
        return true;
      }
    }

    if (this.rotationConfig.strategy === 'time' || this.rotationConfig.strategy === 'hybrid') {
      const interval = this.rotationConfig.interval || 'daily';
      const rotationDate = new Date(this.lastRotationTime);
      
      switch (interval) {
        case 'hourly':
          rotationDate.setHours(rotationDate.getHours() + 1);
          break;
        case 'daily':
          rotationDate.setDate(rotationDate.getDate() + 1);
          break;
        case 'weekly':
          rotationDate.setDate(rotationDate.getDate() + 7);
          break;
        case 'monthly':
          rotationDate.setMonth(rotationDate.getMonth() + 1);
          break;
      }
      
      if (now >= rotationDate) {
        return true;
      }
    }

    return false;
  }

  private async rotateFile(): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFilePath = this.filePath.replace(
        /(\.[^.]*)?$/,
        `-${timestamp}$1`
      );

      // 重命名当前文件
      try {
        await fs.rename(this.filePath, rotatedFilePath);
        
        // 压缩旧文件
        if (this.rotationConfig.compress) {
          void this.compressFile(rotatedFilePath);
        }
        
        // 清理旧文件
        await this.cleanupOldFiles();
      } catch (error) {
        // 文件可能不存在，忽略错误
      }

      this.currentSize = 0;
      this.lastRotationTime = new Date();
    } catch (error) {
      console.error('File rotation error:', error);
    }
  }

  private async compressFile(filePath: string): Promise<void> {
    try {
      // 这里可以使用压缩库，如zlib
      // 为了简单起见，这里只是示例
      const compressed = filePath + '.gz';
      await fs.rename(filePath, compressed);
    } catch (error) {
      console.error('File compression error:', error);
    }
  }

  private async cleanupOldFiles(): Promise<void> {
    if (!this.rotationConfig.maxFiles) {
      return;
    }

    try {
      const dir = path.dirname(this.filePath);
      const files = await fs.readdir(dir);
      const baseName = path.basename(this.filePath, path.extname(this.filePath));
      
      const logFiles = files
        .filter(file => file.startsWith(baseName) && file !== path.basename(this.filePath))
        .map(file => ({
          name: file,
          path: path.join(dir, file),
          stats: fs.stat(path.join(dir, file))
        }))
        .filter(file => file.name !== path.basename(this.filePath));

      const sortedFiles = await Promise.all(
        logFiles.map(async file => ({
          ...file,
          stats: await file.stats
        }))
      ).then(files => files.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime()));

      // 保留最新的文件
      const filesToRemove = sortedFiles.slice(this.rotationConfig.maxFiles);
      
      await Promise.all(
        filesToRemove.map(async file => {
          try {
            await fs.unlink(file.path);
          } catch (error) {
            console.error(`Failed to remove old log file ${file.path}:`, error);
          }
        })
      );
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }

  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || this.writeFileQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      
      const lines = [...this.writeFileQueue];
      this.writeFileQueue.length = 0;
      
      await fs.appendFile(this.filePath, lines.join(''));
    } finally {
      this.isWriting = false;
      
      if (this.writeFileQueue.length > 0) {
        await this.processWriteQueue();
      }
    }
  }

  public async flush(): Promise<void> {
    await this.processWriteQueue();
  }

  public async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * HTTP传输器 - 远程日志服务
 */
export class HTTPTransport extends BaseTransport {
  public readonly name = 'http';
  
  private endpoint: string;
  private batchInterval: number;
  private batchSize: number;
  private retryPolicy: {
    maxRetries: number;
    retryDelay: number;
  };
  private batch: LogEntry[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(
    endpoint: string,
    formatter?: LogFormatter,
    options?: {
      batchInterval?: number;
      batchSize?: number;
      retryPolicy?: {
        maxRetries?: number;
        retryDelay?: number;
      };
    }
  ) {
    super(formatter || new JSONFormatter());
    this.endpoint = endpoint;
    this.batchInterval = options?.batchInterval || 5000; // 5秒
    this.batchSize = options?.batchSize || 100;
    this.retryPolicy = {
      maxRetries: options?.retryPolicy?.maxRetries || 3,
      retryDelay: options?.retryPolicy?.retryDelay || 1000
    };
    
    this.startBatchTimer();
  }

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    this.batch.push(entry);
    
    if (this.batch.length >= this.batchSize) {
      await this.flushBatch();
    }
  }

  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      void this.flushBatch();
    }, this.batchInterval);
  }

  private async flushBatch(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const entriesToSend = [...this.batch];
    this.batch.length = 0;

    try {
      await this.sendWithRetry(entriesToSend);
    } catch (error) {
      console.error('HTTP transport error:', error);
      // 失败时重新放入队列
      this.batch.unshift(...entriesToSend);
    }
  }

  private async sendWithRetry(entries: LogEntry[]): Promise<void> {
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < this.retryPolicy.maxRetries) {
      try {
        await this.sendEntries(entries);
        return;
      } catch (error) {
        lastError = error as Error;
        retryCount++;
        
        if (retryCount < this.retryPolicy.maxRetries) {
          await new Promise(resolve => 
            setTimeout(resolve, this.retryPolicy.retryDelay * retryCount)
          );
        }
      }
    }

    throw lastError || new Error('Failed to send logs after retries');
  }

  private async sendEntries(entries: LogEntry[]): Promise<void> {
    const payload = {
      logs: entries.map(entry => {
        const formatted = this.formatter.format(entry);
        return typeof formatted === 'object' ? formatted : { message: formatted };
      }),
      metadata: {
        timestamp: new Date().toISOString(),
        count: entries.length,
        source: 'blade-logger'
      }
    };

    const response = await axios.post(this.endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Blade-Logger/1.0.0'
      },
      timeout: 10000
    });

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  public async flush(): Promise<void> {
    await this.flushBatch();
  }

  public async close(): Promise<void> {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    await this.flushBatch();
  }
}

/**
 * WebSocket传输器 - 实时日志流
 */
export class WebSocketTransport extends BaseTransport {
  public readonly name = 'websocket';
  
  private url: string;
  private reconnectPolicy: {
    maxRetries: number;
    retryDelay: number;
  };
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private connectionPromise: Promise<void> | null = null;

  constructor(
    url: string,
    formatter?: LogFormatter,
    options?: {
      reconnectPolicy?: {
        maxRetries?: number;
        retryDelay?: number;
      };
    }
  ) {
    super(formatter || new JSONFormatter());
    this.url = url;
    this.reconnectPolicy = {
      maxRetries: options?.reconnectPolicy?.maxRetries || 5,
      retryDelay: options?.reconnectPolicy?.retryDelay || 3000
    };
    
    this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
          console.log('WebSocket transport connected');
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket transport error:', error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('WebSocket transport disconnected');
          this.handleReconnection();
        };

      } catch (error) {
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.reconnectPolicy.maxRetries) {
      console.error('WebSocket transport - max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectPolicy.retryDelay * this.reconnectAttempts;
    
    console.log(`WebSocket transport - attempting to reconnect in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        void this.connect();
      } catch (error) {
        console.error('WebSocket transport - reconnection failed:', error);
      }
    }, delay);
  }

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const payload = {
      type: 'log',
      data: typeof formatted === 'object' ? formatted : { message: formatted },
      timestamp: new Date().toISOString()
    };

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      throw new Error(`WebSocket send error: ${error}`);
    }
  }

  public async flush(): Promise<void> {
    // WebSocket不需要flush
  }

  public async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectionPromise = null;
  }
}

/**
 * 流传输器 - 支持Node.js流接口
 */
export class StreamTransport extends BaseTransport {
  public readonly name = 'stream';
  
  private stream: NodeJS.WritableStream;
  private encoding: BufferEncoding;

  constructor(
    stream: NodeJS.WritableStream,
    formatter?: LogFormatter,
    encoding: BufferEncoding = 'utf8'
  ) {
    super(formatter || new TextFormatter());
    this.stream = stream;
    this.encoding = encoding;
  }

  protected async doWrite(formatted: string | object, entry: LogEntry): Promise<void> {
    const data = typeof formatted === 'object' 
      ? JSON.stringify(formatted) + '\n'
      : formatted + '\n';

    return new Promise((resolve, reject) => {
      this.stream.write(data, this.encoding, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public async flush(): Promise<void> {
    if (typeof this.stream.flush === 'function') {
      return new Promise((resolve, reject) => {
        try {
          (this.stream as any).flush?.((error?: Error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          resolve(); // 忽略flush错误
        }
      });
    }
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.stream.end(undefined, undefined, (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        resolve(); // 忽略关闭错误
      }
    });
  }
}

/**
 * 多目标传输器 - 同时写入多个传输器
 */
export class MultiTransport implements LogTransport {
  public readonly name = 'multi';
  public enabled: boolean = true;
  public minLevel: LogLevel = LogLevel.DEBUG;
  public filter?: LogFilter;

  private transports: LogTransport[];

  constructor(transports: LogTransport[]) {
    this.transports = [...transports];
  }

  public async write(entry: LogEntry): Promise<void> {
    if (!this.enabled || entry.level < this.minLevel) {
      return;
    }

    if (this.filter && !this.filter.filter(entry)) {
      return;
    }

    await Promise.all(
      this.transports.filter(t => t.enabled).map(transport => 
        transport.write(entry)
      )
    );
  }

  public async flush(): Promise<void> {
    await Promise.all(
      this.transports.map(transport => transport.flush())
    );
  }

  public async close(): Promise<void> {
    await Promise.all(
      this.transports.map(transport => transport.close())
    );
  }

  public addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  public removeTransport(transport: LogTransport): void {
    const index = this.transports.indexOf(transport);
    if (index > -1) {
      this.transports.splice(index, 1);
    }
  }

  public getTransports(): LogTransport[] {
    return [...this.transports];
  }
}

/**
 * 过滤传输器 - 只转发匹配条件的日志
 */
export class FilterTransport implements LogTransport {
  public readonly name = 'filter';
  public enabled: boolean = true;
  public minLevel: LogLevel = LogLevel.DEBUG;
  public filter?: LogFilter;

  constructor(
    private innerTransport: LogTransport,
    filter: LogFilter
  ) {
    this.filter = filter;
  }

  public async write(entry: LogEntry): Promise<void> {
    if (!this.enabled || entry.level < this.minLevel) {
      return;
    }

    if (this.filter && !this.filter.filter(entry)) {
      return;
    }

    await this.innerTransport.write(entry);
  }

  public async flush(): Promise<void> {
    await this.innerTransport.flush();
  }

  public async close(): Promise<void> {
    await this.innerTransport.close();
  }
}

/**
 * 缓冲传输器 - 缓冲日志并批量处理
 */
export class BufferTransport implements LogTransport {
  public readonly name = 'buffer';
  public enabled: boolean = true;
  public minLevel: LogLevel = LogLevel.DEBUG;
  public filter?: LogFilter;

  private buffer: LogEntry[] = [];
  private maxBufferSize: number;
  private flushInterval: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private innerTransport: LogTransport;

  constructor(
    innerTransport: LogTransport,
    options?: {
      maxBufferSize?: number;
      flushInterval?: number;
    }
  ) {
    this.innerTransport = innerTransport;
    this.maxBufferSize = options?.maxBufferSize || 1000;
    this.flushInterval = options?.flushInterval || 30000; // 30秒

    this.startFlushTimer();
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  public async write(entry: LogEntry): Promise<void> {
    if (!this.enabled || entry.level < this.minLevel) {
      return;
    }

    if (this.filter && !this.filter.filter(entry)) {
      return;
    }

    this.buffer.push(entry);

    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }
  }

  public async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const entriesToWrite = [...this.buffer];
    this.buffer.length = 0;

    await Promise.all(
      entriesToWrite.map(entry => this.innerTransport.write(entry))
    );
  }

  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    await this.flush();
    await this.innerTransport.close();
  }
}