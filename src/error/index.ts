/**
 * Blade 错误处理系统 - 统一导出入口
 * 提供完整的错误处理功能集合
 */

// 核心错误类
export {
  BladeError,
  ConfigError,
  FileSystemError,
  LLMError,
  NetworkError,
  SecurityError,
} from './BladeError.js';
export {
  type DebugToolsConfig,
  ErrorBoundary,
  type ErrorBoundaryConfig,
  type ErrorBoundaryState,
  ErrorDebugTools,
  type ErrorTrace,
  globalDebugTools,
  globalErrorBoundary,
  withDebugTrace,
  withErrorBoundary,
} from './ErrorBoundary.js';
// 错误处理工具 - 直接使用错误类构造函数
export { ErrorMonitor, globalErrorMonitor, monitor } from './ErrorMonitor.js';
export {
  ErrorPersistenceManager,
  type ErrorSerializationConfig,
  ErrorSerializer,
  type ErrorStorageAdapter,
  globalErrorPersistence,
  globalErrorSerializer,
  type MemoryErrorStorage,
  type SerializedError,
} from './ErrorSerializer.js';
export {
  globalRecoveryManager,
  RecoveryManager,
  recoverable,
} from './RecoveryManager.js';
// 错误管理功能
export { globalRetryManager, RetryManager, retry } from './RetryManager.js';
// 类型定义
export {
  ErrorCategory,
  ErrorCodeModule,
  ErrorCodes,
  type ErrorDetails,
  type ErrorMonitoringOptions,
  type ErrorReport,
  ErrorSeverity,
  type RecoveryStrategy,
  type RetryConfig,
} from './types.js';

// 工具函数
export * from './utils/index.js';
