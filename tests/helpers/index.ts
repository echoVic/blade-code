import { jest } from '@jest/globals';

/**
 * 测试辅助函数和工具集合
 * 提供 Blade 项目测试中常用的辅助功能
 */

// 类型定义
export interface TestHelperOptions {
  timeout?: number;
  retries?: number;
  delay?: number;
  verbose?: boolean;
}

export interface AsyncResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  duration: number;
}

// 异步测试工具
export class AsyncTestHelper {
  static async waitFor<T>(
    condition: () => Promise<T> | T,
    options: TestHelperOptions = {}
  ): Promise<T> {
    const { timeout = 5000, retries = 50, delay = 100, verbose = false } = options;
    let lastError: Error | undefined;

    for (let i = 0; i < retries; i++) {
      try {
        const result = await condition();
        if (verbose) {
          console.log(`Condition met after ${i + 1} attempts`);
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (verbose) {
          console.log(`Attempt ${i + 1} failed: ${lastError.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error(
      `Condition not met after ${retries} attempts. Last error: ${lastError?.message}`
    );
  }

  static async waitForEvent<T>(
    emitter: any,
    event: string,
    options: TestHelperOptions = {}
  ): Promise<T> {
    const { timeout = 5000, verbose = false } = options;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Event '${event}' not received within ${timeout}ms`));
      }, timeout);

      const listener = (data: T) => {
        clearTimeout(timer);
        emitter.off?.(event, listener);
        if (verbose) {
          console.log(`Event '${event}' received with data:`, data);
        }
        resolve(data);
      };

      emitter.on?.(event, listener);
    });
  }

  static async measureTime<T>(fn: () => Promise<T> | T): Promise<AsyncResult<T>> {
    const startTime = performance.now();

    try {
      const result = await fn();
      const duration = performance.now() - startTime;
      return {
        success: true,
        data: result,
        duration,
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration,
      };
    }
  }

  static async retry<T>(
    fn: () => Promise<T> | T,
    options: TestHelperOptions = {}
  ): Promise<T> {
    const { retries = 3, delay = 1000, verbose = false } = options;
    let lastError: Error | undefined;

    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (i < retries - 1) {
          if (verbose) {
            console.log(`Attempt ${i + 1} failed, retrying...`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Unknown error occurred');
  }

  static async race<T>(
    promises: Array<Promise<T> | T>,
    options: TestHelperOptions = {}
  ): Promise<T> {
    const { timeout = 5000 } = options;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Race timeout exceeded'));
      }, timeout);
    });

    return Promise.race([...promises, timeoutPromise]);
  }
}

// 数据生成工具
export class TestDataGenerator {
  private static readonly LOREM_IPSUM =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

  static string(
    length: number = 10,
    charset: string = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  ): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return result;
  }

  static email(): string {
    return `test-${this.string(8)}@example.com`;
  }

  static url(path: string = ''): string {
    return `https://example.com/${path}`;
  }

  static uuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  static date(start: Date = new Date(2020, 0, 1), end: Date = new Date()): Date {
    return new Date(
      start.getTime() + Math.random() * (end.getTime() - start.getTime())
    );
  }

  static number(min: number = 0, max: number = 100, decimals: number = 0): number {
    const value = Math.random() * (max - min) + min;
    return decimals === 0 ? Math.floor(value) : parseFloat(value.toFixed(decimals));
  }

  static boolean(): boolean {
    return Math.random() < 0.5;
  }

  static array<T>(generator: () => T, length: number = 5): T[] {
    return Array.from({ length }, generator);
  }

  static object<T extends Record<string, any>>(template: T): T {
    const result: any = {};
    for (const [key, value] of Object.entries(template)) {
      if (typeof value === 'function') {
        result[key] = value();
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) => (typeof item === 'function' ? item() : item));
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.object(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  static words(count: number = 5): string {
    const words = this.LOREM_IPSUM.split(' ');
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count).join(' ');
  }

  static paragraph(sentences: number = 3): string {
    const sentenceCount = this.number(1, sentences);
    const result = [];
    for (let i = 0; i < sentenceCount; i++) {
      const wordCount = this.number(5, 15);
      result.push(this.words(wordCount));
    }
    return result.join('. ') + '.';
  }

  static file(type: 'text' | 'json' | 'csv' = 'text'): string {
    switch (type) {
      case 'json':
        return JSON.stringify(
          {
            id: this.uuid(),
            name: this.words(2),
            createdAt: this.date().toISOString(),
            ...this.object({
              value: () => this.number(),
              status: () => (this.boolean() ? 'active' : 'inactive'),
              tags: () => this.array(() => this.words(1), 3),
            }),
          },
          null,
          2
        );

      case 'csv':
        return this.array(
          () =>
            `${this.uuid()},${this.words(2)},${this.number(1, 100)},${this.date().toISOString()}`,
          10
        ).join('\n');

      default:
        return this.paragraph();
    }
  }
}

// 文件系统测试工具
export class FileSystemTestHelper {
  static async createTempFile(
    content: string,
    extension: string = '.txt'
  ): Promise<string> {
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { writeFile } = await import('fs/promises');

    const fileName = `${TestDataGenerator.string(10)}${extension}`;
    const filePath = join(tmpdir(), fileName);

    await writeFile(filePath, content);
    return filePath;
  }

  static async createTempDirectory(): Promise<string> {
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { mkdir } = await import('fs/promises');

    const dirName = `test-${TestDataGenerator.string(10)}`;
    const dirPath = join(tmpdir(), dirName);

    await mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  static async cleanup(path: string): Promise<void> {
    const { rm } = await import('fs/promises');
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  static async readFile(path: string): Promise<string> {
    const { readFile } = await import('fs/promises');
    return readFile(path, 'utf-8');
  }

  static async writeFile(path: string, content: string): Promise<void> {
    const { writeFile } = await import('fs/promises');
    return writeFile(path, content);
  }
}

// 事件测试工具
export class EventTestHelper {
  static async emitAndWait(
    emitter: any,
    event: string,
    data: any,
    listener: jest.Mock,
    options: TestHelperOptions = {}
  ): Promise<void> {
    const { timeout = 1000 } = options;

    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Listener not called within ${timeout}ms`));
      }, timeout);

      listener.mockImplementationOnce(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    emitter.emit?.(event, data);
    return promise;
  }

  static createEventSpy(): jest.Mock {
    return jest.fn();
  }

  static async waitForEventCount(
    emitter: any,
    event: string,
    expectedCount: number,
    options: TestHelperOptions = {}
  ): Promise<void> {
    const { timeout = 5000, delay = 100 } = options;
    let count = 0;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Event count not reached. Expected: ${expectedCount}, Actual: ${count}`
          )
        );
      }, timeout);

      const listener = () => {
        count++;
        if (count >= expectedCount) {
          clearTimeout(timer);
          emitter.off?.(event, listener);
          resolve();
        }
      };

      emitter.on?.(event, listener);
    });
  }

  static assertEventCalls(
    spy: jest.Mock,
    expectedCalls: number,
    expectedData?: any[]
  ): void {
    expect(spy).toHaveBeenCalledTimes(expectedCalls);
    if (expectedData) {
      expectedData.forEach((data, index) => {
        expect(spy).toHaveBeenNthCalledWith(index + 1, data);
      });
    }
  }
}

// Error 测试工具
export class ErrorTestHelper {
  static async expectError<T>(
    fn: () => Promise<T> | T,
    expectedError: string | RegExp | ErrorConstructor = Error,
    message?: string | RegExp
  ): Promise<void> {
    try {
      await fn();
      fail('Expected function to throw an error');
    } catch (error) {
      if (typeof expectedError === 'string') {
        expect(error.message).toBe(expectedError);
      } else if (expectedError instanceof RegExp) {
        expect(error.message).toMatch(expectedError);
      } else if (expectedError === Error) {
        expect(error).toBeInstanceOf(Error);
      } else {
        expect(error).toBeInstanceOf(expectedError);
      }

      if (message) {
        if (typeof message === 'string') {
          expect(error.message).toBe(message);
        } else {
          expect(error.message).toMatch(message);
        }
      }
    }
  }

  static createTestError(message: string = 'Test error'): Error {
    return new Error(message);
  }

  static createTestErrorChain(): Error {
    const error1 = new Error('First error');
    const error2 = new Error('Second error');
    const error3 = new Error('Third error');

    error1.cause = error2;
    error2.cause = error3;

    return error1;
  }
}

// 性能测试工具
export class PerformanceTestHelper {
  static async measureTime<T>(
    fn: () => Promise<T> | T,
    iterations: number = 1
  ): Promise<{ result: T; averageTime: number; totalTime: number }> {
    const times: number[] = [];
    let result: T;

    for (let i = 0; i < iterations; i++) {
      const startTime = performance.now();
      result = await fn();
      const endTime = performance.now();
      times.push(endTime - startTime);
    }

    const totalTime = times.reduce((sum, time) => sum + time, 0);
    const averageTime = totalTime / iterations;

    return { result: result!, averageTime, totalTime };
  }

  static async benchmark<T>(
    fn: () => Promise<T> | T,
    options: { iterations?: number; threshold?: number } = {}
  ): Promise<{ success: boolean; averageTime: number; message: string }> {
    const { iterations = 100, threshold = 100 } = options;

    const { averageTime } = await this.measureTime(fn, iterations);
    const success = averageTime <= threshold;
    const message = success
      ? `Performance OK: ${averageTime.toFixed(2)}ms (threshold: ${threshold}ms)`
      : `Performance degraded: ${averageTime.toFixed(2)}ms (threshold: ${threshold}ms)`;

    return { success, averageTime, message };
  }

  static async memoryUsage(): Promise<NodeJS.MemoryUsage> {
    return process.memoryUsage();
  }

  static async measureMemoryUsage<T>(
    fn: () => Promise<T> | T
  ): Promise<{
    result: T;
    memoryDiff: { rss: number; heapTotal: number; heapUsed: number; external: number };
  }> {
    const before = await this.memoryUsage();
    const result = await fn();
    const after = await this.memoryUsage();

    return {
      result,
      memoryDiff: {
        rss: after.rss - before.rss,
        heapTotal: after.heapTotal - before.heapTotal,
        heapUsed: after.heapUsed - before.heapUsed,
        external: after.external - before.external,
      },
    };
  }
}

// 环境测试工具
export class EnvironmentTestHelper {
  static setEnv(key: string, value: string): void {
    process.env[key] = value;
  }

  static getEnv(key: string): string | undefined {
    return process.env[key];
  }

  static unsetEnv(key: string): void {
    delete process.env[key];
  }

  static withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const originalEnv = { ...process.env };

    // Set test environment
    Object.keys(env).forEach((key) => {
      process.env[key] = env[key];
    });

    try {
      return fn();
    } finally {
      // Restore original environment
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      });

      Object.keys(originalEnv).forEach((key) => {
        process.env[key] = originalEnv[key];
      });
    }
  }

  static isCI(): boolean {
    return process.env.CI === 'true';
  }

  static isTest(): boolean {
    return process.env.NODE_ENV === 'test';
  }
}

// 测试断言工具
export class TestAssertionHelper {
  static assertCalledWith<T>(mock: jest.Mock, expectedCalls: Array<T[]> = []): void {
    expect(mock).toHaveBeenCalledTimes(expectedCalls.length);
    expectedCalls.forEach((args, index) => {
      expect(mock).toHaveBeenNthCalledWith(index + 1, ...args);
    });
  }

  static assertCalledOnceWith<T>(mock: jest.Mock, ...args: T[]): void {
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(...args);
  }

  static assertNeverCalled(mock: jest.Mock): void {
    expect(mock).not.toHaveBeenCalled();
  }

  static assertAsyncComplete(
    promise: Promise<any>,
    timeout: number = 1000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Async operation did not complete within timeout'));
      }, timeout);

      promise
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch(reject);
    });
  }

  static assertError(error: any, expected: string | RegExp | ErrorConstructor): void {
    if (typeof expected === 'string') {
      expect(error.message).toBe(expected);
    } else if (expected instanceof RegExp) {
      expect(error.message).toMatch(expected);
    } else {
      expect(error).toBeInstanceOf(expected);
    }
  }

  static assertLength<T>(array: T[], expectedLength: number): void {
    expect(array).toHaveLength(expectedLength);
  }

  static assertIncludes<T>(array: T[], item: T): void {
    expect(array).toContain(item);
  }

  static assertExcludes<T>(array: T[], item: T): void {
    expect(array).not.toContain(item);
  }
}

// 导出所有工具
export {
  AsyncTestHelper,
  TestDataGenerator,
  FileSystemTestHelper,
  EventTestHelper,
  ErrorTestHelper,
  PerformanceTestHelper,
  EnvironmentTestHelper,
  TestAssertionHelper,
};
