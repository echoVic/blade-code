/**
 * 测试工具类
 * 提供 Blade 项目测试中常用的工具方法
 */

import { expect, vi } from 'vitest';

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

export type Mock<_T = any> = ReturnType<typeof vi.fn>;

export class TestTools {
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
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Condition not met within ${timeout}ms`);
  }

  static async waitForAsync<T>(
    asyncFn: () => Promise<T>,
    options: TestTimerOptions = {}
  ): Promise<T> {
    const { timeout = 5000 } = options;
    return Promise.race([
      asyncFn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  static async measureTime<T>(
    fn: () => Promise<T> | T
  ): Promise<{ result: T; time: number }> {
    const startTime = Date.now();
    const result = await fn();
    const endTime = Date.now();
    return { result, time: endTime - startTime };
  }

  static createTempPath(prefix = 'test'): string {
    return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  static createTestError(message = 'Test error'): Error {
    const error = new Error(message);
    error.name = 'TestError';
    return error;
  }

  static createTestData<T extends object>(data: T): T {
    return JSON.parse(JSON.stringify(data)) as T;
  }

  static mockEnv(envVars: Record<string, string | undefined>) {
    const originalEnv = { ...process.env };
    Object.assign(process.env, envVars);

    return () => {
      process.env = originalEnv;
    };
  }

  static verifyMockCalls(mockFn: Mock, expectedCalls: any[][]) {
    expect(mockFn).toHaveBeenCalledTimes(expectedCalls.length);
    expectedCalls.forEach((args, index) => {
      expect(mockFn).toHaveBeenNthCalledWith(index + 1, ...args);
    });
  }

  static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static createPromiseController<T = any>() {
    let resolve: (value: T) => void;
    let reject: (reason?: any) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve: resolve!, reject: reject! };
  }
}

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
  createPromiseController,
} = TestTools;

export const TestConfig = {
  defaultTimeout: 5000,
  defaultInterval: 100,
  longTimeout: 30000,
  shortTimeout: 1000,
};
