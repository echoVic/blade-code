# Blade 统一日志系统使用文档

Blade 统一日志系统提供了一套完整、高效且功能丰富的日志解决方案，支持多种输出格式、上下文追踪、性能监控等高级特性。

## 目录

1. [快速开始](#快速开始)
2. [核心概念](#核心概念)
3. [基本使用](#基本使用)
4. [日志级别](#日志级别)
5. [传输器](#传输器)
6. [格式化器](#格式化器)
7. [中间件](#中间件)
8. [上下文追踪](#上下文追踪)
9. [日志管理](#日志管理)
10. [工具集](#工具集)
11. [性能优化](#性能优化)
12. [集成到现有系统](#集成到现有系统)

## 快速开始

### 安装和引入

```typescript
// 引入核心模块
import { Logger, LoggerManager, LogLevel } from './packages/core/src/logger/index.js';

// 创建日志器
const logger = new Logger('my-app');

// 记录日志
logger.info('Application started');
logger.error('An error occurred', new Error('Test error'));

// 在组件中使用
import { LoggerComponent } from './src/agent/LoggerComponent.js';

const loggerComponent = new LoggerComponent('my-component');
loggerComponent.info('Component initialized');
```

## 核心概念

### Logger（日志器）
日志器是记录日志的主要接口，每个日志器都可以独立配置级别、传输器和中间件。

### Transport（传输器）
传输器负责将日志输出到不同的目标，如控制台、文件、HTTP端点等。

### Formatter（格式化器）
格式化器定义日志的输出格式，支持JSON、文本、彩色文本等多种格式。

### Middleware（中间件）
中间件在日志处理过程中执行额外的操作，如性能监控、敏感信息过滤等。

### LogManager（日志管理器）
管理多个日志器实例，并提供全局配置管理功能。

## 基本使用

### 创建日志器

```typescript
import { Logger, LogLevel } from './packages/core/src/logger/index.js';

// 基本创建
const logger = new Logger('my-logger');

// 带配置创建
const configuredLogger = new Logger('configured-logger', {
  level: LogLevel.DEBUG,
  transports: [
    new ConsoleTransport(new ColoredTextFormatter())
  ]
});
```

### 记录日志

```typescript
// 不同级别日志
logger.debug('This is a debug message', { userId: 123 });
logger.info('Application started successfully');
logger.warn('This is a warning', { code: 'WARN001' });
logger.error('An error occurred', new Error('Database connection failed'));
logger.fatal('Critical system error', new Error('System shutdown required'));
```

### 日志级别

```typescript
import { LogLevel } from './packages/core/src/logger/index.js';

// 日志级别常量
const levels = {
  DEBUG: LogLevel.DEBUG,   // 0
  INFO: LogLevel.INFO,     // 1
  WARN: LogLevel.WARN,     // 2
  ERROR: LogLevel.ERROR,   // 3
  FATAL: LogLevel.FATAL    // 4
};

// 设置日志级别
logger.updateConfig({ level: LogLevel.DEBUG });
```

## 传输器

### 控制台传输器

```typescript
import { ConsoleTransport, ColoredTextFormatter } from './packages/core/src/logger/index.js';

const consoleTransport = new ConsoleTransport(new ColoredTextFormatter());
logger.addTransport(consoleTransport);
```

### 文件传输器

```typescript
import { FileTransport, JSONFormatter } from './packages/core/src/logger/index.js';

// 基本文件传输器
const fileTransport = new FileTransport('./logs/app.log', new JSONFormatter());
logger.addTransport(fileTransport);

// 轮转文件传输器
import { RotatingFileTransport } from './packages/core/src/logger/transports.js';

const rotationConfig = {
  enabled: true,
  strategy: 'hybrid',
  maxSize: 10 * 1024 * 1024, // 10MB
  interval: 'daily',
  maxFiles: 30,
  compress: true
};

const rotatingTransport = new RotatingFileTransport(
  './logs/app.log', 
  rotationConfig, 
  new JSONFormatter()
);
logger.addTransport(rotatingTransport);
```

### HTTP传输器

```typescript
import { HTTPTransport } from './packages/core/src/logger/transports.js';

const httpTransport = new HTTPTransport(
  'https://log-server.example.com/logs',
  new JSONFormatter(),
  {
    batchInterval: 5000,
    batchSize: 100,
    retryPolicy: {
      maxRetries: 3,
      retryDelay: 1000
    }
  }
);

logger.addTransport(httpTransport);
```

### 多传输器

```typescript
import { MultiTransport } from './packages/core/src/logger/transports.js';

const multiTransport = new MultiTransport([
  consoleTransport,
  fileTransport,
  httpTransport
]);

logger.addTransport(multiTransport);
```

## 格式化器

### JSON格式化器

```typescript
import { JSONFormatter } from './packages/core/src/logger/index.js';

const jsonFormatter = new JSONFormatter();
const consoleTransport = new ConsoleTransport(jsonFormatter);
```

### 文本格式化器

```typescript
import { TextFormatter } from './packages/core/src/logger/index.js';

const textFormatter = new TextFormatter();
const fileTransport = new FileTransport('./logs/app.log', textFormatter);
```

### 彩色文本格式化器

```typescript
import { ColoredTextFormatter } from './packages/core/src/logger/index.js';

const coloredFormatter = new ColoredTextFormatter();
const consoleTransport = new ConsoleTransport(coloredFormatter);
```

### 结构化格式化器

```typescript
import { StructuredFormatter } from './packages/core/src/logger/utils.js';

const structuredFormatter = new StructuredFormatter({
  includeTimestamp: true,
  includeLevel: true,
  includeSource: true,
  includeRequestId: true,
  includeSessionId: true,
  includeMetadata: true,
  includeStack: true,
  includePerformance: true,
  prettyPrint: false
});

const transport = new FileTransport('./logs/structured.log', structuredFormatter);
```

## 中间件

### 性能监控中间件

```typescript
import { PerformanceMiddleware } from './packages/core/src/logger/index.js';

const perfMiddleware = new PerformanceMiddleware();
logger.addMiddleware(perfMiddleware);
```

### 敏感信息过滤中间件

```typescript
import { SensitiveDataMiddleware } from './packages/core/src/logger/utils.js';

const sensitiveMiddleware = new SensitiveDataMiddleware([
  { pattern: /password["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'password=***' },
  { pattern: /token["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'token=***' },
  { pattern: /api_key["\s]*[:=]["\s]*([^"'\s]+)/gi, replacement: 'api_key=***' }
]);

logger.addMiddleware(sensitiveMiddleware);
```

### 增强中间件

```typescript
import { EnrichmentMiddleware } from './packages/core/src/logger/utils.js';

const enrichmentMiddleware = new EnrichmentMiddleware({
  environment: process.env.NODE_ENV,
  version: process.env.npm_package_version,
  service: 'my-service',
  host: require('os').hostname(),
  pid: process.pid,
  additionalFields: {
    region: 'us-west-2',
    cluster: 'production'
  }
});

logger.addMiddleware(enrichmentMiddleware);
```

### 压缩中间件

```typescript
import { CompressionMiddleware } from './packages/core/src/logger/utils.js';

const compressionMiddleware = new CompressionMiddleware(
  1000,  // 最大消息长度
  true   // 压缩大消息
);

logger.addMiddleware(compressionMiddleware);
```

## 上下文追踪

### 设置上下文

```typescript
// 设置请求ID、会话ID和用户ID
logger.setContext({
  requestId: 'req-1234567890abcdef',
  sessionId: 'sess-fedcba0987654321',
  userId: 'user-987654321'
});

// 记录上下文相关的日志
logger.info('User login attempt', { action: 'login', ip: '192.168.1.1' });
```

### 清除上下文

```typescript
// 清除当前上下文
logger.clearContext();
```

### 自动生成上下文

```typescript
import { logUtils } from './packages/core/src/logger/utils.js';

// 自动生成请求ID
const requestId = logUtils.generateRequestId();
logger.setContext({ requestId });

// 动态创建会话
if (!logger.context.sessionId) {
  const sessionId = logUtils.generateSessionId();
  logger.setContext({ sessionId });
}
```

## 日志管理

### 搜索日志

```typescript
import { LogManagerService } from './packages/core/src/logger/management.js';

const logManager = new LogManagerService();

// 基本搜索
const result = await logManager.search({
  level: LogLevel.ERROR,
  keyword: 'database',
  timeRange: {
    start: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24小时前
    end: new Date()
  },
  source: 'database-service'
});

console.log(`找到 ${result.total} 条日志`);
result.entries.forEach(entry => {
  console.log(`${entry.timestamp} [${entry.level}] ${entry.message}`);
});
```

### 分页查询

```typescript
const pagedResult = await logManager.search({
  level: LogLevel.INFO,
  pagination: {
    page: 1,
    pageSize: 50
  },
  sort: {
    field: 'timestamp',
    order: 'desc'
  }
});
```

### 日志分析

```typescript
const analysis = await logManager.analyzeLogs({
  timeRange: {
    start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7天前
    end: new Date()
  }
});

console.log(`错误率: ${analysis.errorRate.toFixed(2)}%`);
console.log('最常见的错误:');
analysis.topErrors.forEach(error => {
  console.log(`  ${error.message}: ${error.count} 次`);
});
```

### 日志导出

```typescript
// 导出日志到文件
await logManager.exportLogs(
  {
    level: LogLevel.ERROR,
    timeRange: {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date()
    }
  },
  './exports/error-logs.json'
);
```

## 工具集

### 时间工具

```typescript
import { timeUtils } from './packages/core/src/logger/utils.js';

// 格式化持续时间
console.log(timeUtils.formatDuration(1500)); // "1.5s"
console.log(timeUtils.formatDuration(70000)); // "1.2m"

// 获取相对时间
const pastDate = new Date(Date.now() - 3600000); // 1小时前
console.log(timeUtils.getRelativeTime(pastDate)); // "1h ago"
```

### 日志工具

```typescript
import { logUtils } from './packages/core/src/logger/utils.js';

// 字节转换
console.log(logUtils.bytesToSize(1048576)); // "1 MB"

// 内存使用情况
console.log(logUtils.getMemoryUsage());

// 深度克隆
const original = { a: 1, b: { c: 2 } };
const cloned = logUtils.deepClone(original);

// 截断字符串
const longText = 'This is a very long message that needs to be truncated';
console.log(logUtils.truncate(longText, 20)); // "This is a very long..."
```

### 工厂函数

```typescript
import {
  createLogger,
  createConsoleTransport,
  createFileTransport,
  createHTTPTransport
} from './packages/core/src/logger/logger-exports.js';

// 创建日志器
const logger = createLogger('my-app', {
  level: LogLevel.INFO
});

// 创建传输器
const consoleTransport = createConsoleTransport();
const fileTransport = createFileTransport('./logs/app.log', true); // 启用轮转
const httpTransport = createHTTPTransport('https://log-server.example.com/logs');

logger.addTransport(consoleTransport);
logger.addTransport(fileTransport);
logger.addTransport(httpTransport);
```

## 性能优化

### 异步日志记录

```typescript
// 所有日志记录都是异步的，不会阻塞主线程
logger.info('This is asynchronous');

// 批量处理日志
for (let i = 0; i < 1000; i++) {
  logger.debug('Bulk log message', { index: i });
}
```

### 缓冲传输器

```typescript
import { BufferTransport } from './packages/core/src/logger/transports.js';

const fileTransport = new FileTransport('./logs/app.log', new JSONFormatter());
const bufferTransport = new BufferTransport(fileTransport, {
  maxBufferSize: 1000,
  flushInterval: 30000 // 30秒
});

logger.addTransport(bufferTransport);
```

### 日志采样

```typescript
import { SamplingMiddleware } from './packages/core/src/logger/utils.js';

const samplingMiddleware = new SamplingMiddleware(
  0.1, // 10% 采样率
  [LogLevel.DEBUG, LogLevel.INFO] // 只对DEBUG和INFO级别采样
);

logger.addMiddleware(samplingMiddleware);
```

## 集成到现有系统

### 集成LoggerComponent

```typescript
import { LoggerComponent } from './src/agent/LoggerComponent.js';

// 在组件中使用
class MyComponent {
  private logger: LoggerComponent;

  constructor() {
    this.logger = new LoggerComponent('MyComponent');
    this.logger.setLogLevel('debug');
  }

  async doWork() {
    this.logger.info('Starting work');
    
    try {
      // 执行工作
      await this.performTask();
      this.logger.info('Work completed successfully');
    } catch (error) {
      this.logger.error('Work failed', error);
      throw error;
    }
  }

  private async performTask() {
    // 模拟工作
    this.logger.debug('Performing task', { taskId: 'task-123' });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
```

### 替换console.log

```typescript
// 替换前
console.log('Processing user:', userId);
console.warn('Deprecated feature used');
console.error('Failed to process request:', error);

// 替换后
logger.info('Processing user', { userId });
logger.warn('Deprecated feature used', { feature: 'old-api' });
logger.error('Failed to process request', error);
```

### 系统级集成

```typescript
// 在应用启动时配置全局日志器
import { LoggerManager } from './packages/core/src/logger/index.js';

const loggerManager = LoggerManager.getInstance();

// 配置全局设置
loggerManager.updateConfig({
  level: process.env.LOG_LEVEL ? LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel] : LogLevel.INFO,
  transports: [
    new ConsoleTransport(new ColoredTextFormatter())
  ],
  context: {
    enableRequestTracking: true,
    enableSessionTracking: true
  }
});

// 获取应用日志器
const appLogger = loggerManager.getLogger('app');
```

## 完整示例

```typescript
import {
  Logger,
  LoggerManager,
  LogLevel,
  ConsoleTransport,
  RotatingFileTransport,
  JSONFormatter,
  ColoredTextFormatter,
  LogRotationConfig,
  PerformanceMiddleware,
  SensitiveDataMiddleware
} from './packages/core/src/logger/index.js';
import { EnrichmentMiddleware } from './packages/core/src/logger/utils.js';

// 创建应用日志器
const logger = new Logger('my-application', {
  level: LogLevel.INFO,
  context: {
    enableRequestTracking: true,
    enableSessionTracking: true
  },
  performance: {
    enabled: true,
    sampleRate: 0.1,
    thresholds: {
      logTime: 5,
      memory: 100
    }
  }
});

// 配置控制台输出
const consoleTransport = new ConsoleTransport(new ColoredTextFormatter());
logger.addTransport(consoleTransport);

// 配置文件输出（带轮转）
const rotationConfig: LogRotationConfig = {
  enabled: true,
  strategy: 'hybrid',
  maxSize: 50 * 1024 * 1024, // 50MB
  interval: 'daily',
  maxFiles: 30,
  compress: true
};

const fileTransport = new RotatingFileTransport(
  './logs/application.log',
  rotationConfig,
  new JSONFormatter()
);
logger.addTransport(fileTransport);

// 添加中间件
logger.addMiddleware(new PerformanceMiddleware());
logger.addMiddleware(new SensitiveDataMiddleware());
logger.addMiddleware(new EnrichmentMiddleware({
  environment: process.env.NODE_ENV || 'development',
  version: '1.0.0',
  service: 'my-app'
}));

// 使用日志器
logger.info('Application started');

// 设置上下文
logger.setContext({
  requestId: Math.random().toString(36).substring(2, 15),
  sessionId: Math.random().toString(36).substring(2, 15)
});

// 记录不同级别的日志
logger.debug('Debug information', { debugData: 'some data' });
logger.info('Processing user request', { userId: 'user-123' });
logger.warn('Deprecated API used', { api: '/old-endpoint' });

try {
  // 模拟操作
  throw new Error('Simulated error');
} catch (error) {
  logger.error('Failed to process request', error, { 
    endpoint: '/api/users', 
    method: 'POST' 
  });
}

// 性能敏感的操作
const startTime = performance.now();
// ... 执行一些操作 ...
const endTime = performance.now();
logger.info('Operation completed', { 
  duration: endTime - startTime,
  operation: 'data-processing'
});
```

以上文档提供了Blade统一日志系统的完整使用指南，涵盖了从基础使用到高级功能的所有方面。