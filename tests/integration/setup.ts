/**
 * 集成测试配置和设置
 */

import { jest } from '@jest/globals';

// 集成测试环境设置
export class IntegrationTestSetup {
  private static initialized = false;

  static async setup() {
    if (this.initialized) return;

    // 设置环境变量
    process.env.NODE_ENV = 'test';
    process.env.INTEGRATION_TEST = 'true';

    // 模拟网络请求
    global.fetch = jest.fn();

    // 模拟文件系统
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn(),
      writeFileSync: jest.fn(),
      existsSync: jest.fn(),
      promises: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        access: jest.fn(),
      },
    }));

    // 模拟子进程
    jest.mock('child_process', () => ({
      exec: jest.fn(),
      execSync: jest.fn(),
      spawn: jest.fn(),
    }));

    this.initialized = true;
  }

  static async teardown() {
    // 清理模拟
    jest.clearAllMocks();

    // 重置环境变量
    delete process.env.INTEGRATION_TEST;

    this.initialized = false;
  }
}

// 测试数据管理器
export class IntegrationTestDataManager {
  private static dataStores: Map<string, any[]> = new Map();

  static createTestData<T>(key: string, factory: () => T, count: number = 1): T[] {
    const data = Array.from({ length: count }, factory);
    this.dataStores.set(key, data as any[]);
    return data;
  }

  static getTestData<T>(key: string): T[] {
    return this.dataStores.get(key) || [];
  }

  static clearTestData(key?: string) {
    if (key) {
      this.dataStores.delete(key);
    } else {
      this.dataStores.clear();
    }
  }
}

// 集成测试工具类
export class IntegrationTestUtils {
  /**
   * 创建临时数据库连接
   */
  static async createTempDatabase(): Promise<any> {
    // 在实际实现中，这里会创建一个内存数据库或测试数据库连接
    return {
      query: jest.fn(),
      execute: jest.fn(),
      close: jest.fn(),
    };
  }

  /**
   * 创建临时文件系统
   */
  static async createTempFileSystem(): Promise<any> {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tempDir = path.join(os.tmpdir(), `test-${Date.now()}`);

    return {
      root: tempDir,
      cleanup: async () => {
        // 清理临时目录
        if (fs.existsSync(tempDir)) {
          await fs.promises.rm(tempDir, { recursive: true });
        }
      },
    };
  }

  /**
   * 模拟外部服务
   */
  static mockExternalService(serviceName: string, responses: any[]): any {
    const mockService = {
      calls: [] as any[],
      responses: [...responses],
      call: jest.fn(async (request: any) => {
        mockService.calls.push(request);
        const response = mockService.responses.shift();
        if (response instanceof Error) {
          throw response;
        }
        return response;
      }),
    };

    // 根据服务名称设置全局模拟
    switch (serviceName) {
      case 'http':
        global.fetch = mockService.call as any;
        break;
    }

    return mockService;
  }

  /**
   * 等待异步操作完成
   */
  static async waitForAsyncOperations(
    operations: Array<() => Promise<any>>,
    options: { timeout?: number; concurrency?: number } = {}
  ): Promise<any[]> {
    const { timeout = 5000, concurrency = 1 } = options;

    if (concurrency === 1) {
      // 顺序执行
      const results = [];
      for (const operation of operations) {
        const result = await Promise.race([
          operation(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Operation timeout')), timeout)
          ),
        ]);
        results.push(result);
      }
      return results;
    } else {
      // 并发执行（限制并发数）
      const results: any[] = [];
      for (let i = 0; i < operations.length; i += concurrency) {
        const batch = operations.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map((op) =>
            Promise.race([
              op(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Operation timeout')), timeout)
              ),
            ])
          )
        );
        results.push(...batchResults);
      }
      return results;
    }
  }

  /**
   * 验证集成测试结果
   */
  static validateIntegrationResult(
    result: any,
    expectations: { [key: string]: any }
  ): boolean {
    for (const [key, expectedValue] of Object.entries(expectations)) {
      if (typeof expectedValue === 'function') {
        if (!expectedValue(result[key])) {
          return false;
        }
      } else if (result[key] !== expectedValue) {
        return false;
      }
    }
    return true;
  }
}

// 集成测试生命周期管理
export class IntegrationTestLifecycle {
  private static setups: Array<() => Promise<void>> = [];
  private static teardowns: Array<() => Promise<void>> = [];

  static addSetup(setupFn: () => Promise<void>) {
    this.setups.push(setupFn);
  }

  static addTeardown(teardownFn: () => Promise<void>) {
    this.teardowns.push(teardownFn);
  }

  static async runAllSetups() {
    for (const setup of this.setups) {
      await setup();
    }
  }

  static async runAllTeardowns() {
    // 逆序执行清理函数
    for (let i = this.teardowns.length - 1; i >= 0; i--) {
      try {
        await this.teardowns[i]();
      } catch (error) {
        console.warn('Teardown error:', error);
      }
    }

    this.setups = [];
    this.teardowns = [];
  }
}

// 使用示例：
// beforeAll(async () => {
//   await IntegrationTestSetup.setup();
//   await IntegrationTestLifecycle.runAllSetups();
// });
//
// afterAll(async () => {
//   await IntegrationTestLifecycle.runAllTeardowns();
//   await IntegrationTestSetup.teardown();
// });

// 导出所有工具
export {
  IntegrationTestSetup,
  IntegrationTestDataManager,
  IntegrationTestUtils,
  IntegrationTestLifecycle,
};
