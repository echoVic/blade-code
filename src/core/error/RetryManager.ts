/**
 * 重试管理器
 * 提供指数退避、重试策略和熔断器功能
 */

import { BladeError } from './BladeError.js';
import { ErrorCodeModule, type RetryConfig } from './types.js';

/**
 * 重试状态
 */
interface RetryState {
  attempts: number;
  lastAttempt: number;
  nextDelay: number;
  errors: BladeError[];
}

/**
 * 熔断器状态
 */
enum CircuitState {
  CLOSED = 'CLOSED',      // 关闭状态，正常请求
  OPEN = 'OPEN',          // 开启状态，拒绝请求
  HALF_OPEN = 'HALF_OPEN' // 半开状态，尝试恢复
}

/**
 * 熔断器配置
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // 失败阈值
  recoveryTimeout: number;  // 恢复超时（毫秒）
  expectedException?: (error: BladeError) => boolean; // 期望的异常
}

/**
 * 重试管理器类
 */
export class RetryManager {
  private retryConfig: RetryConfig;
  private circuitBreakerConfig?: CircuitBreakerConfig;
  private retryStates: Map<string, RetryState> = new Map();
  private circuitStates: Map<string, { state: CircuitState; failures: number; lastFailure: number }> = new Map();

  constructor(config: Partial<RetryConfig> = {}, circuitBreakerConfig?: CircuitBreakerConfig) {
    this.retryConfig = {
      maxAttempts: 3,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffFactor: 2,
      jitter: true,
      retryableErrors: [],
      ...config
    };
    
    this.circuitBreakerConfig = circuitBreakerConfig;
  }

  /**
   * 执行带有重试的异步操作
   */
  async execute<T>(
    operation: () => Promise<T>,
    operationId?: string
  ): Promise<T> {
    const id = operationId || this.generateOperationId();
    const retryState = this.getOrCreateRetryState(id);
    
    // 检查熔断器状态
    if (this.circuitBreakerConfig) {
      const circuitState = this.getCircuitState(id);
      if (circuitState.state === CircuitState.OPEN) {
        throw new BladeError(
          ErrorCodeModule.CORE,
          '0004',
          `操作 "${id}" 被熔断器拒绝`,
          {
            category: 'NETWORK' as any,
            retryable: false,
            context: { circuitState: circuitState.state }
          }
        );
      }
    }

    while (retryState.attempts < this.retryConfig.maxAttempts) {
      try {
        const result = await operation();
        
        // 成功，重置状态
        this.resetState(id);
        return result;
        
      } catch (error) {
        const bladeError = error instanceof BladeError 
          ? error 
          : BladeError.from(error as Error);
        
        retryState.errors.push(bladeError);
        retryState.attempts++;
        retryState.lastAttempt = Date.now();
        
        // 检查是否可重试
        if (!this.shouldRetry(bladeError, retryState.attempts)) {
          this.updateCircuitState(id, false); // 更新熔断器状态（失败）
          throw bladeError;
        }
        
        // 计算延迟
        retryState.nextDelay = this.calculateDelay(retryState.attempts);
        
        // 记录重试信息
        console.warn(`重试操作 "${id}" (尝试 ${retryState.attempts}/${this.retryConfig.maxAttempts})，延迟 ${retryState.nextDelay}ms`);
        
        // 等待延迟
        await this.delay(retryState.nextDelay);
      }
    }
    
    // 达到最大重试次数
    this.updateCircuitState(id, false); // 更新熔断器状态（失败）
    throw retryState.errors[retryState.errors.length - 1];
  }

  /**
   * 执行带有重试和超时的异步操作
   */
  async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationId?: string
  ): Promise<T> {
    const id = operationId || this.generateOperationId();
    
    return Promise.race([
      this.execute(operation, id),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new BladeError(
            ErrorCodeModule.CORE,
            '0004',
            `操作 "${id}" 超时`,
            {
              category: 'TIMEOUT' as any,
              retryable: true,
              context: { timeout: timeoutMs }
            }
          ));
        }, timeoutMs);
      })
    ]);
  }

  /**
   * 获取重试状态
   */
  getRetryState(operationId: string): RetryState | undefined {
    return this.retryStates.get(operationId);
  }

  /**
   * 重置状态
   */
  resetState(operationId: string): void {
    this.retryStates.delete(operationId);
    this.updateCircuitState(operationId, true); // 更新熔断器状态（成功）
  }

  /**
   * 清理过期的状态
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = this.retryConfig.maxDelay * 10; // 10倍最大延迟时间
    
    for (const [id, state] of this.retryStates.entries()) {
      if (now - state.lastAttempt > maxAge) {
        this.retryStates.delete(id);
      }
    }
    
    // 清理熔断器状态
    if (this.circuitBreakerConfig) {
      for (const [, circuitState] of this.circuitStates.entries()) {
        if (circuitState.state === CircuitState.OPEN && 
            now - circuitState.lastFailure > this.circuitBreakerConfig.recoveryTimeout) {
          // 熔断器超时，进入半开状态
          circuitState.state = CircuitState.HALF_OPEN;
        }
      }
    }
  }

  /**
   * 获取或创建重试状态
   */
  private getOrCreateRetryState(operationId: string): RetryState {
    if (!this.retryStates.has(operationId)) {
      const state: RetryState = {
        attempts: 0,
        lastAttempt: 0,
        nextDelay: 0,
        errors: []
      };
      this.retryStates.set(operationId, state);
    }
    return this.retryStates.get(operationId)!;
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: BladeError, attempts: number): boolean {
    // 检查是否达到最大重试次数
    if (attempts >= this.retryConfig.maxAttempts) {
      return false;
    }
    
    // 检查错误是否在可重试列表中
    if (this.retryConfig.retryableErrors.length > 0) {
      return this.retryConfig.retryableErrors.includes(error.code);
    }
    
    // 默认情况下，检查错误是否标记为可重试
    return error.isRetryable();
  }

  /**
   * 计算退避延迟
   */
  private calculateDelay(attempts: number): number {
    let delay = this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffFactor, attempts - 1);
    
    // 应用最大延迟限制
    delay = Math.min(delay, this.retryConfig.maxDelay);
    
    // 添加抖动（随机性）
    if (this.retryConfig.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }
    
    return Math.floor(delay);
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 生成操作ID
   */
  private generateOperationId(): string {
    return `retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取熔断器状态
   */
  private getCircuitState(operationId: string) {
    if (!this.circuitBreakerConfig) {
      return { state: CircuitState.CLOSED, failures: 0, lastFailure: 0 };
    }
    
    if (!this.circuitStates.has(operationId)) {
      this.circuitStates.set(operationId, {
        state: CircuitState.CLOSED,
        failures: 0,
        lastFailure: 0
      });
    }
    
    return this.circuitStates.get(operationId)!;
  }

  /**
   * 更新熔断器状态
   */
  private updateCircuitState(operationId: string, success: boolean): void {
    if (!this.circuitBreakerConfig) {
      return;
    }
    
    const circuitState = this.getCircuitState(operationId);
    
    if (success) {
      // 成功：重置熔断器
      circuitState.state = CircuitState.CLOSED;
      circuitState.failures = 0;
    } else {
      // 失败：增加失败计数
      circuitState.failures++;
      circuitState.lastFailure = Date.now();
      
      // 检查是否应该开启熔断器
      if (circuitState.failures >= this.circuitBreakerConfig.failureThreshold) {
        circuitState.state = CircuitState.OPEN;
      }
    }
  }
}

/**
 * 全局重试管理器实例
 */
export const globalRetryManager = new RetryManager();

/**
 * 创建重试装饰器
 */
export function retry(config: Partial<RetryConfig> = {}) {
  const retryManager = new RetryManager(config);
  
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const operationId = `${target.constructor.name}.${propertyKey}`;
      return retryManager.execute(() => originalMethod.apply(this, args), operationId);
    };
    
    return descriptor;
  };
}