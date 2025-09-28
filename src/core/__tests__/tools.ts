/**
 * 测试工具类
 * 提供 Blade 项目测试中常用的工具方法
 */

import { vi, expect } from 'vitest';

// 类型定义
export interface TestTimerOptions {
  timeout?: number;
  interval?: number;
}

export interface MockFunctionOptions {
  returnValue?: any;
  errorValue?: Error;
  implementation?: (...args: any[]) => any;
  callCount?: number;
}

// 重新导出 vi.Mock 作为 Mock 类型
export type Mock<T = any> = ReturnType<typeof vi.fn>;

// 测试工具类
export class TestTools {
  /**
   * 创建 Mock 函数
   */
  static createMock<T = any>(options: MockFunctionOptions = {}): Mock<T> {
    const mockFn = vi.fn();
    
    if (options.implementation) {
      mockFn.mockImplementation(options.implementation);
    } else if (options.errorValue) {
      mockFn.mockImplementation(() => {
        throw options.errorValue;
      });
    } else if (options.returnValue !== undefined) {
      if (options.callCount && options.callCount > 1) {
        // 多次调用返回不同值
        const returnValues = Array.isArray(options.returnValue) 
          ? options.returnValue 
          : Array(options.callCount).fill(options.returnValue);
        mockFn.mockReturnValueOnce(returnValues[0]);
        for (let i = 1; i < returnValues.length; i++) {
          mockFn.mockReturnValueOnce(returnValues[i]);
        }
      } else {
        mockFn.mockReturnValue(options.returnValue);
      }
    }
    
    return mockFn;
  }
  
  /**
   * 等待条件满足
   */
  static async waitForCondition(
    condition: () => boolean | Promise<boolean>,
    options: TestTimerOptions = {}
  ): Promise<void> {
    const { timeout = 5000, interval = 100 } = options;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const result = await condition();
      if (result) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error(`Condition not met within ${timeout}ms`);
  }
  
  /**
   * 等待异步函数完成
   */
  static async waitForAsync<T>(
    asyncFn: () => Promise<T>,
    validator: (result: T) => boolean,
    options: TestTimerOptions = {}
  ): Promise<T> {
    const { timeout = 5000, interval = 100 } = options;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const result = await asyncFn();
        if (validator(result)) {
          return result;
        }
      } catch (error) {
        // 忽略错误，继续等待
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error(`Async function did not complete successfully within ${timeout}ms`);
  }
  
  /**
   * 测量函数执行时间
   */
  static async measureTime<T>(
    fn: () => T | Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const startTime = performance.now();
    const result = await Promise.resolve(fn());
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    return { result, duration };
  }
  
  /**
   * 创建临时文件路径
   */
  static createTempPath(extension: string = '.tmp'): string {
    return `/tmp/test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}${extension}`;
  }
  
  /**
   * 创建测试错误
   */
  static createTestError(message: string = 'Test error', code?: string): Error {
    const error = new Error(message);
    if (code) {
      (error as any).code = code;
    }
    return error;
  }
  
  /**
   * 创建测试数据
   */
  static createTestData<T>(template: T, count: number = 1): T[] {
    return Array.from({ length: count }, () => ({ ...template as any }));
  }
  
  /**
   * 模拟环境变量
   */
  static mockEnv(vars: Record<string, string>): () => void {
    const originalEnv = { ...process.env };
    
    Object.keys(vars).forEach(key => {
      process.env[key] = vars[key];
    });
    
    // 返回恢复函数
    return () => {
      Object.keys(process.env).forEach(key => {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      });
      
      Object.keys(originalEnv).forEach(key => {
        process.env[key] = originalEnv[key];
      });
    };
  }
  
  /**
   * 验证 Mock 调用
   */
  static verifyMockCalls(mockFn: Mock, expectedCalls: number, expectedArgs?: any[][]): void {
    expect(mockFn).toHaveBeenCalledTimes(expectedCalls);
    
    if (expectedArgs) {
      expectedArgs.forEach((args, index) => {
        expect(mockFn).toHaveBeenNthCalledWith(index + 1, ...args);
      });
    }
  }
  
  /**
   * 创建异步延迟
   */
  static async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 创建 Promise 控制器
   */
  static createPromiseController<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
  } {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;
    
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    
    return { promise, resolve: resolve!, reject: reject! };
  }
}

// 快捷导出常用工具
export const {
  createMock,
  waitForCondition,
  waitForAsync,
  measureTime,
  createTempPath,
  createTestError,
  createTestData,
  mockEnv,
  verifyMockCalls,
  delay,
  createPromiseController
} = TestTools;

// 默认测试配置
export const TestConfig = {
  defaultTimeout: 5000,
  defaultInterval: 100,
  longTimeout: 30000,
  shortTimeout: 1000
};

// 测试数据生成器
export class TestDataGenerator {
  /**
   * 生成随机字符串
   */
  static string(length: number = 10): string {
    return Math.random().toString(36).substring(2, length + 2);
  }
  
  /**
   * 生成随机数字
   */
  static number(min: number = 0, max: number = 100): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  /**
   * 生成随机布尔值
   */
  static boolean(): boolean {
    return Math.random() > 0.5;
  }
  
  /**
   * 生成随机日期
   */
  static date(start: Date = new Date(2020, 0, 1), end: Date = new Date()): Date {
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  }
  
  /**
   * 生成随机数组
   */
  static array<T>(generator: () => T, length: number = 5): T[] {
    return Array.from({ length }, generator);
  }
  
  /**
   * 生成随机对象
   */
  static object<T extends Record<string, any>>(template: T): T {
    const result: any = {};
    Object.keys(template).forEach(key => {
      const value = template[key];
      if (typeof value === 'function') {
        result[key] = value();
      } else {
        result[key] = value;
      }
    });
    return result;
  }
}

export const {
  string: randomString,
  number: randomNumber,
  boolean: randomBoolean,
  date: randomDate,
  array: randomArray,
  object: randomObject
} = TestDataGenerator;