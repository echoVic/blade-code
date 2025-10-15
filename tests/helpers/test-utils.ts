/**
 * 测试工具库
 * 提供常用的测试辅助函数和工具
 */

import { expect, vi } from 'vitest';
import { testConfig } from '../test.config';

/**
 * 测试数据生成器
 */
export class TestDataGenerator {
  /**
   * 生成随机字符串
   */
  static randomString(length: number = 10): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 生成随机数字
   */
  static randomNumber(min: number = 0, max: number = 100): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * 生成随机布尔值
   */
  static randomBoolean(): boolean {
    return Math.random() > 0.5;
  }

  /**
   * 生成随机日期
   */
  static randomDate(start: Date = new Date(2020, 0, 1), end: Date = new Date()): Date {
    return new Date(
      start.getTime() + Math.random() * (end.getTime() - start.getTime())
    );
  }

  /**
   * 生成随机数组
   */
  static randomArray<T>(generator: () => T, length: number = 5): T[] {
    return Array.from({ length }, generator);
  }

  /**
   * 生成随机对象
   */
  static randomObject<T extends Record<string, any>>(schema: T): T {
    const result = {} as T;
    for (const [key, value] of Object.entries(schema)) {
      if (typeof value === 'function') {
        result[key] = value();
      } else if (typeof value === 'string') {
        result[key] = TestDataGenerator.randomString();
      } else if (typeof value === 'number') {
        result[key] = TestDataGenerator.randomNumber();
      } else if (typeof value === 'boolean') {
        result[key] = TestDataGenerator.randomBoolean();
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

/**
 * 模拟工具类
 */
export class MockUtils {
  /**
   * 创建网络延迟模拟
   */
  static createNetworkDelay(
    ms: number = testConfig.get('MOCK_NETWORK_DELAY')
  ): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 创建文件系统模拟
   */
  static createFileSystemMock() {
    const mockFiles = new Map<string, string>();
    const mockDirs = new Set<string>();

    return {
      readFile: vi.fn((path: string) => {
        if (!mockFiles.has(path)) {
          throw new Error(`File not found: ${path}`);
        }
        return Promise.resolve(mockFiles.get(path)!);
      }),

      writeFile: vi.fn((path: string, content: string) => {
        mockFiles.set(path, content);
        return Promise.resolve();
      }),

      exists: vi.fn((path: string) => {
        return Promise.resolve(mockFiles.has(path) || mockDirs.has(path));
      }),

      mkdir: vi.fn((path: string) => {
        mockDirs.add(path);
        return Promise.resolve();
      }),

      readdir: vi.fn((path: string) => {
        if (!mockDirs.has(path)) {
          throw new Error(`Directory not found: ${path}`);
        }
        return Promise.resolve([]);
      }),

      unlink: vi.fn((path: string) => {
        mockFiles.delete(path);
        return Promise.resolve();
      }),

      rmdir: vi.fn((path: string) => {
        mockDirs.delete(path);
        return Promise.resolve();
      }),

      // 测试辅助方法
      _setFile: (path: string, content: string) => {
        mockFiles.set(path, content);
      },

      _setDir: (path: string) => {
        mockDirs.add(path);
      },

      _clear: () => {
        mockFiles.clear();
        mockDirs.clear();
      },
    };
  }

  /**
   * 创建HTTP客户端模拟
   */
  static createHttpMock() {
    const responses = new Map<string, any>();

    return {
      get: vi.fn((url: string) => {
        const response = responses.get(`GET:${url}`) || { data: {}, status: 200 };
        return Promise.resolve(response);
      }),

      post: vi.fn((url: string, data?: any) => {
        const response = responses.get(`POST:${url}`) || { data: {}, status: 200 };
        return Promise.resolve(response);
      }),

      put: vi.fn((url: string, data?: any) => {
        const response = responses.get(`PUT:${url}`) || { data: {}, status: 200 };
        return Promise.resolve(response);
      }),

      delete: vi.fn((url: string) => {
        const response = responses.get(`DELETE:${url}`) || { data: {}, status: 200 };
        return Promise.resolve(response);
      }),

      // 测试辅助方法
      _setResponse: (method: string, url: string, response: any) => {
        responses.set(`${method.toUpperCase()}:${url}`, response);
      },

      _clear: () => {
        responses.clear();
      },
    };
  }
}

/**
 * 断言工具类
 */
export class AssertUtils {
  /**
   * 断言异步函数抛出特定错误
   */
  static async expectAsyncError<T>(
    fn: () => Promise<T>,
    expectedError?: string | RegExp | Error
  ): Promise<void> {
    try {
      await fn();
      expect.fail('Expected function to throw an error');
    } catch (error) {
      if (expectedError) {
        if (typeof expectedError === 'string') {
          expect(error.message).toContain(expectedError);
        } else if (expectedError instanceof RegExp) {
          expect(error.message).toMatch(expectedError);
        } else {
          expect(error).toBeInstanceOf(expectedError.constructor);
        }
      }
    }
  }

  /**
   * 断言对象包含特定属性
   */
  static expectToContain<T extends Record<string, any>>(
    obj: T,
    properties: Partial<T>
  ): void {
    for (const [key, value] of Object.entries(properties)) {
      expect(obj).toHaveProperty(key, value);
    }
  }

  /**
   * 断言数组包含特定元素
   */
  static expectArrayToContain<T>(array: T[], expectedItem: T): void {
    expect(array).toContain(expectedItem);
  }

  /**
   * 断言函数被调用指定次数
   */
  static expectFunctionCalledTimes(
    mockFn: ReturnType<typeof vi.fn>,
    expectedTimes: number
  ): void {
    expect(mockFn).toHaveBeenCalledTimes(expectedTimes);
  }

  /**
   * 断言函数被调用时包含特定参数
   */
  static expectFunctionCalledWith(
    mockFn: ReturnType<typeof vi.fn>,
    expectedArgs: any[]
  ): void {
    expect(mockFn).toHaveBeenCalledWith(...expectedArgs);
  }
}

/**
 * 测试环境工具类
 */
export class TestEnvironmentUtils {
  /**
   * 设置测试环境变量
   */
  static setEnvVars(vars: Record<string, string>): void {
    Object.entries(vars).forEach(([key, value]) => {
      process.env[key] = value;
    });
  }

  /**
   * 恢复环境变量
   */
  static restoreEnvVars(originalEnv: Record<string, string | undefined>): void {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }

  /**
   * 创建临时目录
   */
  static async createTempDir(): Promise<string> {
    const os = await import('os');
    const path = await import('path');
    return path.join(
      os.tmpdir(),
      `test-${Date.now()}-${TestDataGenerator.randomString(8)}`
    );
  }

  /**
   * 等待指定时间
   */
  static async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 等待条件满足
   */
  static async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return;
      }
      await this.wait(interval);
    }

    throw new Error(`Condition not met within ${timeout}ms`);
  }
}

/**
 * 测试生命周期工具类
 */
export class TestLifecycleUtils {
  private static originalEnv: Record<string, string | undefined> = {};

  /**
   * 测试前设置
   */
  static async beforeTest(): Promise<void> {
    // 保存原始环境变量
    this.originalEnv = { ...process.env };

    // 设置测试环境
    testConfig.applyToEnvironment();

    // 清理模拟
    vi.clearAllMocks();
  }

  /**
   * 测试后清理
   */
  static async afterTest(): Promise<void> {
    // 恢复环境变量
    TestEnvironmentUtils.restoreEnvVars(this.originalEnv);

    // 清理模拟
    vi.clearAllMocks();
    vi.clearAllTimers();
  }

  /**
   * 测试套件前设置
   */
  static async beforeSuite(): Promise<void> {
    if (testConfig.isDebugMode()) {
      console.log('🧪 Starting test suite');
    }
  }

  /**
   * 测试套件后清理
   */
  static async afterSuite(): Promise<void> {
    if (testConfig.isDebugMode()) {
      console.log('✅ Test suite completed');
    }
  }
}

// 导出所有工具类
export {
  AssertUtils,
  TestDataGenerator as DataGen,
  TestEnvironmentUtils as EnvUtils,
  TestLifecycleUtils as LifecycleUtils,
  MockUtils,
};
