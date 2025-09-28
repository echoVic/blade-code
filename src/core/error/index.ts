/**
 * Blade 错误处理系统 - 统一导出入口
 * 提供完整的错误处理功能集合
 */

// 核心错误类
export { BladeError, ConfigError, LLMError, NetworkError, FileSystemError, SecurityError } from './BladeError.js';

// 类型定义
export {
  ErrorSeverity,
  ErrorCategory,
  ErrorCodeModule,
  ErrorCodes,
  type ErrorDetails,
  type ErrorMonitoringOptions,
  type RetryConfig,
  type RecoveryStrategy,
  type ErrorReport
} from './types.js';

// 错误管理功能
export { RetryManager, globalRetryManager, retry } from './RetryManager.js';
export { RecoveryManager, globalRecoveryManager, recoverable } from './RecoveryManager.js';
export { ErrorMonitor, globalErrorMonitor, monitor } from './ErrorMonitor.js';

// 错误处理工具
export { ErrorFactory, BatchErrorFactory } from './ErrorFactory.js';
export {
  ErrorSerializer,
  globalErrorSerializer,
  ErrorPersistenceManager,
  globalErrorPersistence,
  type ErrorStorageAdapter,
  type SerializedError,
  type ErrorSerializationConfig,
  type MemoryErrorStorage
} from './ErrorSerializer.js';
export {
  ErrorBoundary,
  ErrorDebugTools,
  globalErrorBoundary,
  globalDebugTools,
  withErrorBoundary,
  withDebugTrace,
  type ErrorBoundaryConfig,
  type ErrorBoundaryState,
  type ErrorTrace,
  type DebugToolsConfig
} from './ErrorBoundary.js';

// 工具函数
export * from './utils/index.js';