/**
 * 安全工具模块
 * 导出所有安全相关的工具和实用程序
 */

import { CommandExecutor } from '../command-executor.js';
import { ConfigEncryptor } from '../config-encryptor.js';
import { ErrorHandler } from '../error-handler.js';
import { PathSecurity } from '../path-security.js';
import { PromptSecurity } from '../prompt-security.js';
import { SecureHttpClient } from '../secure-http-client.js';

// 命令执行安全
export { CommandExecutor } from '../command-executor.js';

// 配置加密
export { ConfigEncryptor } from '../config-encryptor.js';
// 错误处理
export { ErrorHandler } from '../error-handler.js';
// 路径安全
export { PathSecurity } from '../path-security.js';
// 提示词安全
export { PromptSecurity } from '../prompt-security.js';

// HTTP 客户端安全
export { SecureHttpClient } from '../secure-http-client.js';

// 安全常量
export const SECURITY_CONSTANTS = {
  // 加密相关
  ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  KEY_LENGTH: 32,
  IV_LENGTH: 16,
  TAG_LENGTH: 16,
  SALT_LENGTH: 32,

  // 路径相关
  MAX_PATH_LENGTH: 4096,
  MAX_FILENAME_LENGTH: 255,

  // 命令执行相关
  DEFAULT_TIMEOUT: 30000,
  DEFAULT_MAX_BUFFER: 1024 * 1024,

  // HTTP 相关
  DEFAULT_RETRY_ATTEMPTS: 3,
  DEFAULT_RETRY_DELAY: 1000,
  DEFAULT_RATE_LIMIT_REQUESTS: 100,
  DEFAULT_RATE_LIMIT_PERIOD: 60000,

  // 提示词相关
  MAX_PROMPT_LENGTH: 10000,
  MAX_INPUT_LENGTH: 4000,

  // 错误相关
  MAX_ERROR_MESSAGE_LENGTH: 500,
};

// 安全工具集
export const SecurityUtils = {
  path: PathSecurity,
  config: ConfigEncryptor,
  command: CommandExecutor,
  prompt: PromptSecurity,
  error: ErrorHandler,
  http: SecureHttpClient,
};

// 安全装饰器
export function Secure(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    try {
      // 在方法执行前进行安全检查
      await performSecurityChecks(args);

      // 执行原方法
      const result = await originalMethod.apply(this, args);

      // 在方法执行后进行结果验证
      return validateResult(result);
    } catch (error) {
      // 使用错误处理器处理错误
      const safeError = ErrorHandler.createFriendlyError(error as Error);
      throw safeError;
    }
  };
}

// 辅助函数
async function performSecurityChecks(args: any[]): Promise<void> {
  // 检查参数中的路径
  for (const arg of args) {
    if (typeof arg === 'string' && (arg.includes('/') || arg.includes('\\'))) {
      // 尝试验证路径
      try {
        await PathSecurity.securePath(arg);
      } catch {
        // 如果是路径验证失败，继续检查其他参数
      }
    }

    // 检查提示词注入
    if (typeof arg === 'string' && arg.length > 10) {
      const injection = PromptSecurity.detectPromptInjection(arg);
      if (injection.isInjection && injection.confidence > 0.7) {
        throw new Error('检测到潜在的提示词注入攻击');
      }
    }
  }
}

function validateResult(result: any): any {
  // 验证返回结果是否安全
  if (typeof result === 'string') {
    // 检查是否包含敏感信息（简单的敏感信息检测）
    const sensitivePatterns = [
      /password/i,
      /token/i,
      /key/i,
      /secret/i,
      /api[_-]?key/i,
    ];

    let sanitized = result;
    for (const pattern of sensitivePatterns) {
      if (pattern.test(result)) {
        console.warn('返回结果包含潜在敏感信息，已进行脱敏处理');
        sanitized = result.replace(pattern, '[REDACTED]');
      }
    }

    return sanitized;
  }

  return result;
}
