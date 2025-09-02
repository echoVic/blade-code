# Blade 错误处理系统使用文档

## 概述

Blade 错误处理系统提供了一套完整的错误管理解决方案，包括统一的错误类型、错误码体系、错误处理工具和错误管理功能。

## 核心特性

1. **统一错误类型系统** - 提供标准化的错误分类和错误码
2. **错误管理功能** - 支持重试、恢复、监控等高级功能
3. **错误处理工具** - 提供错误创建、序列化、边界等工具
4. **集成配置和日志** - 与系统配置和日志系统无缝集成

## 错误类型和错误码体系

### 错误严重程度

```typescript
export enum ErrorSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
  FATAL = 'FATAL'
}
```

### 错误类别

```typescript
export enum ErrorCategory {
  BUSINESS = 'BUSINESS',
  VALIDATION = 'VALIDATION',
  CONFIGURATION = 'CONFIGURATION',
  SYSTEM = 'SYSTEM',
  RUNTIME = 'RUNTIME',
  MEMORY = 'MEMORY',
  DISK = 'DISK',
  NETWORK = 'NETWORK',
  HTTP = 'HTTP',
  TIMEOUT = 'TIMEOUT',
  CONNECTION = 'CONNECTION',
  LLM = 'LLM',
  API = 'API',
  DATABASE = 'DATABASE',
  FILE_SYSTEM = 'FILE_SYSTEM',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  SECURITY = 'SECURITY'
}
```

### 错误模块和错误码

```typescript
// 核心模块错误码 (0001-0999)
export const CoreErrorCodes = {
  INITIALIZATION_FAILED: '0001',
  COMPONENT_INIT_FAILED: '0002',
  LIFECCLE_ERROR: '0003',
  INTERNAL_ERROR: '0004',
  UNKNOWN_ERROR: '0005'
};

// 配置模块错误码 (1001-1999)
export const ConfigErrorCodes = {
  CONFIG_NOT_FOUND: '1001',
  CONFIG_INVALID: '1002',
  CONFIG_LOAD_FAILED: '1003',
  CONFIG_SAVE_FAILED: '1004',
  MISSING_REQUIRED_CONFIG: '1005',
  CONFIG_VALIDATION_FAILED: '1006'
};

// LLM模块错误码 (2001-2999)
export const LLMErrorCodes = {
  API_KEY_MISSING: '2001',
  BASE_URL_MISSING: '2002',
  MODEL_NAME_MISSING: '2003',
  API_CALL_FAILED: '2004',
  RATE_LIMIT_EXCEEDED: '2005',
  INVALID_MODEL: '2006',
  RESPONSE_PARSE_ERROR: '2007',
  TIMEOUT_EXCEEDED: '2008',
  TOKEN_LIMIT_EXCEEDED: '2009',
  CONTENT_FILTERED: '2010'
};
```

## 使用方法

### 1. 创建错误

```typescript
import { ErrorFactory, BladeError } from '@blade-ai/error';

// 创建通用错误
const error1 = ErrorFactory.createError('操作失败');

// 创建配置错误
const error2 = ErrorFactory.createConfigError(
  'CONFIG_INVALID',
  '配置文件格式无效'
);

// 创建LLM错误
const error3 = ErrorFactory.createLLMError(
  'API_CALL_FAILED',
  '调用LLM API失败',
  {
    retryable: true,
    context: { model: 'gpt-4', endpoint: 'https://api.openai.com/v1/chat/completions' }
  }
);

// 创建网络错误
const error4 = ErrorFactory.createNetworkError(
  'REQUEST_FAILED',
  'HTTP请求失败',
  { context: { url: 'https://api.example.com', method: 'POST' } }
);

// 从原生错误创建
const nativeError = new Error('原生错误');
const bladeError = ErrorFactory.fromNativeError(nativeError, '转换后的错误');
```

### 2. 错误处理

```typescript
import { globalRetryManager, globalRecoveryManager, globalErrorMonitor } from '@blade-ai/error';

async function apiCall() {
  try {
    // 使用重试管理器
    const result = await globalRetryManager.execute(async () => {
      const response = await fetch('https://api.example.com/data');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    }, 'api_call');
    
    return result;
  } catch (error) {
    // 监控错误
    globalErrorMonitor.monitor(error);
    
    // 尝试恢复
    const recoveryResult = await globalRecoveryManager.recover(error);
    if (recoveryResult.success) {
      console.log('错误已恢复:', recoveryResult.message);
      return apiCall(); // 重试操作
    }
    
    throw error;
  }
}
```

### 3. 错误边界

```typescript
import { globalErrorBoundary } from '@blade-ai/error';

// 包装异步函数
async function riskyOperation() {
  return await globalErrorBoundary.wrap(async () => {
    // 可能出错的操作
    const result = await someRiskyAPICall();
    return result;
  }, { operation: 'riskyOperation' });
}

// 包装同步函数
function riskySyncOperation() {
  return globalErrorBoundary.wrapSync(() => {
    // 可能出错的同步操作
    return someRiskyCalculation();
  }, { operation: 'riskySyncOperation' });
}
```

### 4. 错误序列化

```typescript
import { globalErrorSerializer, globalErrorPersistence } from '@blade-ai/error';

// 序列化错误
const error = new BladeError('CORE', '0004', '测试错误');
const serialized = globalErrorSerializer.serialize(error);
const jsonString = globalErrorSerializer.toJson(error, 2);

// 反序列化错误
const deserialized = globalErrorSerializer.fromJson(jsonString);

// 持久化错误
const errorId = await globalErrorPersistence.saveError(error);
const loadedError = await globalErrorPersistence.loadError(errorId);
```

## 高级功能

### 1. 重试管理

```typescript
import { RetryManager } from '@blade-ai/error';

const retryManager = new RetryManager({
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  jitter: true,
  retryableErrors: ['NETWORK_8001', 'LLM_2004']
});

// 执行带重试的操作
const result = await retryManager.execute(async () => {
  return await fetch('https://api.example.com/data');
}, 'data_fetch');
```

### 2. 错误恢复

```typescript
import { RecoveryManager } from '@blade-ai/error';

const recoveryManager = new RecoveryManager({
  maxAttempts: 3,
  recoveryTimeout: 10000
});

// 注册恢复策略
recoveryManager.registerStrategy({
  name: 'network-reconnect',
  condition: (error) => error.category === 'NETWORK',
  action: async (error) => {
    // 实现网络重连逻辑
    await networkReconnect();
    return true;
  },
  maxAttempts: 3
});

// 执行带恢复的操作
const result = await recoveryManager.executeWithRecovery(async () => {
  return await someOperation();
}, 'operation_with_recovery');
```

### 3. 错误监控

```typescript
import { ErrorMonitor } from '@blade-ai/error';

const errorMonitor = new ErrorMonitor({
  enabled: true,
  sampleRate: 0.1, // 10%采样率
  maxErrorsPerMinute: 100,
  excludePatterns: ['password', 'token'],
  includePatterns: ['API', 'LLM'],
  autoReport: true,
  reportEndpoint: 'https://monitoring.example.com/errors'
});

// 监控错误
await errorMonitor.monitor(new Error('测试错误'));

// 获取统计信息
const stats = errorMonitor.getStatistics();
console.log('错误统计:', stats);

// 导出错误数据
const csvData = errorMonitor.exportData('csv');
```

## 集成示例

### 与配置系统集成

```typescript
import { ConfigManager } from '@blade-ai/config';
import { ErrorFactory, globalErrorMonitor } from '@blade-ai/error';

class EnhancedConfigManager extends ConfigManager {
  private loadUserConfig(): void {
    const configPath = path.join(os.homedir(), '.blade', 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const file = fs.readFileSync(configPath, 'utf-8');
        const userConfig = JSON.parse(file);
        Object.assign(this.config, userConfig);
      }
    } catch (error) {
      const configError = ErrorFactory.createConfigError(
        'CONFIG_LOAD_FAILED',
        '用户配置加载失败',
        {
          context: { configPath },
          retryable: false,
          suggestions: ['检查配置文件格式', '确认文件权限']
        }
      );
      
      globalErrorMonitor.monitor(configError);
      console.warn('用户配置加载失败，将使用默认配置');
    }
  }
}
```

### 与日志系统集成

```typescript
import { LoggerComponent } from '@blade-ai/logger';
import { BladeError } from '@blade-ai/error';

class EnhancedLoggerComponent extends LoggerComponent {
  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    super.error(message, error, metadata);
    
    // 记录Blade错误的详细信息
    if (error instanceof BladeError) {
      this.debug('错误详情', {
        code: error.code,
        module: error.module,
        category: error.category,
        severity: error.severity,
        retryable: error.retryable,
        recoverable: error.recoverable,
        suggestions: error.suggestions,
        context: error.context,
        ...metadata
      });
    }
  }
}
```

## 最佳实践

### 1. 错误处理原则

```typescript
// ✅ 好的做法：使用结构化错误
function goodExample() {
  try {
    const result = performOperation();
    return result;
  } catch (error) {
    // 转换为结构化错误
    throw ErrorFactory.createBusinessError(
      'OPERATION_FAILED',
      '操作失败',
      { cause: error }
    );
  }
}

// ❌ 避免的做法：使用原始错误
function badExample() {
  try {
    const result = performOperation();
    return result;
  } catch (error) {
    // 不提供结构化信息
    throw new Error('操作失败');
  }
}
```

### 2. 错误恢复策略

```typescript
// 定义恢复策略
const recoveryStrategies = {
  network: {
    condition: (error) => error.category === 'NETWORK',
    action: async () => {
      // 网络恢复逻辑
      await checkNetworkConnectivity();
      return true;
    }
  },
  config: {
    condition: (error) => error.module === 'CONFIG',
    action: async () => {
      // 配置恢复逻辑
      await reloadConfig();
      return true;
    }
  }
};

// 使用恢复策略
async function resilientOperation() {
  try {
    return await performOperation();
  } catch (error) {
    for (const [name, strategy] of Object.entries(recoveryStrategies)) {
      if (strategy.condition(error)) {
        const success = await strategy.action();
        if (success) {
          return await resilientOperation(); // 重试
        }
      }
    }
    throw error;
  }
}
```

### 3. 错误监控和报告

```typescript
// 设置全局错误处理器
process.on('uncaughtException', async (error) => {
  await globalErrorMonitor.monitor(error);
  console.error('未捕获的异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  await globalErrorMonitor.monitor(error);
  console.error('未处理的Promise拒绝:', error);
});

// 定期报告错误统计
setInterval(() => {
  const stats = globalErrorMonitor.getStatistics();
  if (stats.totalErrors > 0) {
    // 发送统计报告
    sendErrorReport(stats);
  }
}, 60000); // 每分钟检查一次
```

## 故障排除

### 常见问题

1. **错误没有被正确监控**
   - 确保调用了 `globalErrorMonitor.monitor(error)`
   - 检查监控配置中的 `enabled` 和 `sampleRate` 设置

2. **重试机制不工作**
   - 确认错误设置了 `retryable: true`
   - 检查重试管理器的配置参数

3. **恢复策略未触发**
   - 确认错误条件匹配策略的 `condition` 函数
   - 检查恢复策略是否已正确注册

### 调试技巧

```typescript
// 启用调试模式
import { globalDebugTools } from '@blade-ai/error';
globalDebugTools.enable();

// 追踪操作
globalDebugTools.startTrace('complex_operation');

try {
  const result = await complexOperation();
  globalDebugTools.endTrace('complex_operation');
  return result;
} catch (error) {
  globalDebugTools.endTrace('complex_operation', error);
  throw error;
}
```

通过使用Blade错误处理系统，您可以构建更加健壮和可维护的应用程序，提供更好的错误处理体验和系统稳定性。