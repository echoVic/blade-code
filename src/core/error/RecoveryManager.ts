/**
 * 错误恢复管理器
 * 提供错误恢复策略和自动恢复功能
 */

import { BladeError } from './BladeError.js';
import type { RecoveryStrategy } from './types.js';
import { ErrorCodeModule } from './types.js';

/**
 * 恢复上下文
 */
export interface RecoveryContext {
  error: BladeError;
  attempts: number;
  maxAttempts: number;
  operationId: string;
  startTime: number;
  additionalContext?: Record<string, any>;
}

/**
 * 恢复结果
 */
export interface RecoveryResult {
  success: boolean;
  recovered?: boolean;
  message?: string;
  action?: string;
  nextStep?: string;
  context?: RecoveryContext;
}

/**
 * 错误恢复管理器类
 */
export class RecoveryManager {
  private strategies: Map<string, RecoveryStrategy> = new Map();
  private defaultMaxAttempts: number = 3;
  private recoveryTimeout: number = 10000; // 10秒恢复超时

  constructor(options?: { maxAttempts?: number; recoveryTimeout?: number }) {
    if (options) {
      this.defaultMaxAttempts = options.maxAttempts || this.defaultMaxAttempts;
      this.recoveryTimeout = options.recoveryTimeout || this.recoveryTimeout;
    }

    this.initializeDefaultStrategies();
  }

  /**
   * 注册恢复策略
   */
  registerStrategy(strategy: RecoveryStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * 取消注册恢复策略
   */
  unregisterStrategy(name: string): void {
    this.strategies.delete(name);
  }

  /**
   * 尝试恢复错误
   */
  async recover(
    error: BladeError,
    operationId?: string,
    context?: Record<string, any>
  ): Promise<RecoveryResult> {
    const startTime = Date.now();
    let attempts = 0;

    // 查找适用的恢复策略
    const applicableStrategies = Array.from(this.strategies.values()).filter(strategy =>
      strategy.condition(error)
    );

    if (applicableStrategies.length === 0) {
      return {
        success: false,
        recovered: false,
        message: '没有找到适用的恢复策略',
        context: {
          error,
          attempts,
          maxAttempts: 0,
          operationId: operationId || 'unknown',
          startTime,
          additionalContext: context,
        },
      };
    }

    // 按顺序尝试恢复策略
    for (const strategy of applicableStrategies) {
      attempts++;

      try {
        const timeoutPromise = new Promise<boolean>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`恢复策略 "${strategy.name}" 超时`));
          }, this.recoveryTimeout);
        });

        const recoveryPromise = strategy.action(error);

        const success = await Promise.race([recoveryPromise, timeoutPromise]);

        if (success) {
          return {
            success: true,
            recovered: true,
            message: `使用策略 "${strategy.name}" 成功恢复`,
            action: strategy.name,
            nextStep: '继续执行',
            context: {
              error,
              attempts,
              maxAttempts: strategy.maxAttempts,
              operationId: operationId || 'unknown',
              startTime,
              additionalContext: context,
            },
          };
        }
      } catch (recoveryError) {
        console.warn(`恢复策略 "${strategy.name}" 执行失败:`, recoveryError);

        // 当前策略失败，继续尝试下一个策略
        if (attempts >= applicableStrategies.length) {
          break;
        }

        // 短暂延迟后继续
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 所有可能的策略都尝试失败
    return {
      success: false,
      recovered: false,
      message: '所有恢复策略都失败了',
      context: {
        error,
        attempts,
        maxAttempts: applicableStrategies.reduce((sum, s) => sum + s.maxAttempts, 0),
        operationId: operationId || 'unknown',
        startTime,
        additionalContext: context,
      },
    };
  }

  /**
   * 执行带有恢复能力的操作
   */
  async executeWithRecovery<T>(
    operation: () => Promise<T>,
    operationId?: string,
    context?: Record<string, any>
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const bladeError = error instanceof BladeError ? error : BladeError.from(error as Error);

      // 尝试恢复
      const recoveryResult = await this.recover(bladeError, operationId, context);

      if (recoveryResult.success && recoveryResult.recovered) {
        console.info(`错误恢复成功: ${recoveryResult.message}`);

        // 如果可以重新尝试操作，则重试
        if (recoveryResult.nextStep === '继续执行') {
          return await operation();
        }
      }

      // 恢复失败，抛出以下错误
      throw new BladeError(
        ErrorCodeModule.CORE,
        '0004',
        `错误无法恢复: ${recoveryResult.message}`,
        {
          category: bladeError.category,
          retryable: false,
          context: {
            originalError: bladeError,
            recoveryResult,
          },
        }
      );
    }
  }

  /**
   * 获取恢复策略统计
   */
  getStatistics(): Record<
    string,
    {
      used: number;
      success: number;
      failure: number;
      averageDuration: number;
    }
  > {
    // 这里应该是实际的统计数据，现阶段返回空对象
    return {};
  }

  /**
   * 初始化默认恢复策略
   */
  private initializeDefaultStrategies(): void {
    // 网络重连策略
    this.registerStrategy({
      name: 'network-reconnect',
      condition: error => error.category === 'NETWORK',
      action: async error => {
        // 模拟网络重连
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
      },
      maxAttempts: 3,
    });

    // 配置重新加载策略
    this.registerStrategy({
      name: 'config-reload',
      condition: error => error.category === 'CONFIGURATION',
      action: async error => {
        // 模拟配置重新加载
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
      },
      maxAttempts: 2,
    });

    // 缓存清理策略
    this.registerStrategy({
      name: 'cache-clear',
      condition: error => error.code.includes('CONTEXT'),
      action: async error => {
        // 模拟缓存清理
        await new Promise(resolve => setTimeout(resolve, 300));
        return true;
      },
      maxAttempts: 1,
    });

    // 内存优化策略
    this.registerStrategy({
      name: 'memory-optimize',
      condition: error => error.category === 'MEMORY',
      action: async error => {
        // 模拟内存优化
        global.gc && global.gc();
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
      },
      maxAttempts: 2,
    });

    // 权限重试策略
    this.registerStrategy({
      name: 'permission-retry',
      condition: error => error.code.includes('PERMISSION'),
      action: async error => {
        // 模拟权限重试
        await new Promise(resolve => setTimeout(resolve, 2000));
        return false; // 权限问题通常需要用户干预
      },
      maxAttempts: 1,
    });
  }
}

/**
 * 全局错误恢复管理器实例
 */
export const globalRecoveryManager = new RecoveryManager();

/**
 * 创建恢复装饰器
 */
export function recoverable(strategyNames: string[] = []) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const operationId = `${target.constructor.name}.${propertyKey}`;

      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        const bladeError = error instanceof BladeError ? error : BladeError.from(error as Error);

        // 使用指定的策略进行恢复
        const applicableStrategies = Array.from(globalRecoveryManager['strategies'].values())
          .filter(strategy => strategyNames.length === 0 || strategyNames.includes(strategy.name))
          .filter(strategy => strategy.condition(bladeError));

        if (applicableStrategies.length > 0) {
          const recoveryResult = await globalRecoveryManager.recover(bladeError, operationId);

          if (recoveryResult.success && recoveryResult.recovered) {
            // 恢复成功，重试操作
            return await originalMethod.apply(this, args);
          }
        }

        // 恢复失败，重新抛出错误
        throw bladeError;
      }
    };

    return descriptor;
  };
}
