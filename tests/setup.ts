/**
 * 全局测试设置文件
 * 提供所有测试类型的基础配置和模拟
 */

import { TextDecoder, TextEncoder } from 'util';
import { afterEach, beforeAll, vi } from 'vitest';

// 全局设置
(global as any).TextEncoder = TextEncoder;
(global as any).TextDecoder = TextDecoder;

// 模拟 Node.js 的 fetch API
if (!global.fetch) {
  global.fetch = vi.fn();
}

// 测试环境配置
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';
process.env.LOG_LEVEL = 'error';
process.env.DEBUG_TESTS = process.env.DEBUG_TESTS || 'false';

// 控制台输出管理
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const createConsoleMock = (original: typeof console.log, name: string) => {
  return vi.fn((...args) => {
    if (process.env.DEBUG_TESTS === 'true' || process.env.VERBOSE_TESTS === 'true') {
      original(`[${name}]`, ...args);
    }
  });
};

console.log = createConsoleMock(originalConsoleLog, 'LOG');
console.warn = createConsoleMock(originalConsoleWarn, 'WARN');
console.error = createConsoleMock(originalConsoleError, 'ERROR');

// 错误处理
process.on('unhandledRejection', (reason, promise) => {
  if (process.env.DEBUG_TESTS === 'true') {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  }
});

process.on('uncaughtException', (error) => {
  if (process.env.DEBUG_TESTS === 'true') {
    console.error('Uncaught Exception:', error);
  }
});

// 文件系统模拟（默认调用真实实现，便于按需覆写）
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');

  const wrapSync = <K extends keyof typeof actual>(key: K) => {
    const original = actual[key];
    if (typeof original !== 'function') {
      return original;
    }
    return vi.fn((...args: unknown[]) =>
      (original as (...inner: unknown[]) => unknown).apply(actual, args)
    );
  };

  const wrapAsync = <K extends keyof typeof actual.promises>(key: K) => {
    const original = actual.promises[key];
    if (typeof original !== 'function') {
      return original;
    }
    return vi.fn((...args: unknown[]) =>
      (original as (...inner: unknown[]) => unknown).apply(actual.promises, args)
    );
  };

  return {
    ...actual,
    readFileSync: wrapSync('readFileSync'),
    writeFileSync: wrapSync('writeFileSync'),
    existsSync: wrapSync('existsSync'),
    mkdirSync: wrapSync('mkdirSync'),
    readdirSync: wrapSync('readdirSync'),
    statSync: wrapSync('statSync'),
    unlinkSync: wrapSync('unlinkSync'),
    rmdirSync: wrapSync('rmdirSync'),
    promises: {
      ...actual.promises,
      readFile: wrapAsync('readFile'),
      writeFile: wrapAsync('writeFile'),
      access: wrapAsync('access'),
      mkdir: wrapAsync('mkdir'),
      readdir: wrapAsync('readdir'),
      stat: wrapAsync('stat'),
      unlink: wrapAsync('unlink'),
      rmdir: wrapAsync('rmdir'),
      rm: wrapAsync('rm'),
    },
  };
});

// 子进程模拟
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    exec: vi.fn(),
    spawn: vi.fn(),
    fork: vi.fn(),
    execFile: vi.fn(),
  };
});

// 网络请求模拟
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const createInstance = () => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    head: vi.fn(),
    options: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  });
  const mockAxios = {
    ...createInstance(),
    create: vi.fn(createInstance),
  };
  return {
    ...actual,
    default: mockAxios,
    create: mockAxios.create,
    get: mockAxios.get,
    post: mockAxios.post,
    put: mockAxios.put,
    delete: mockAxios.delete,
    patch: mockAxios.patch,
    head: mockAxios.head,
    options: mockAxios.options,
    interceptors: mockAxios.interceptors,
  };
});

// WebSocket模拟
vi.mock('ws', async () => {
  const actual = await vi.importActual<typeof import('ws')>('ws');
  return {
    ...actual,
    WebSocket: vi.fn(() => ({
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  };
});

// HTTP/HTTPS模拟
vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    createServer: vi.fn(),
    request: vi.fn(),
    get: vi.fn(),
  };
});

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  return {
    ...actual,
    createServer: vi.fn(),
    request: vi.fn(),
    get: vi.fn(),
  };
});

// 测试工具函数
const testUtils = {
  /**
   * 创建模拟数据
   */
  createMockData: <T>(factory: () => T, count: number = 1): T[] => {
    return Array.from({ length: count }, factory);
  },

  /**
   * 等待指定时间
   */
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),

  /**
   * 创建模拟Promise
   */
  createMockPromise: <T>(value: T, delay: number = 0): Promise<T> => {
    return new Promise((resolve) => {
      setTimeout(() => resolve(value), delay);
    });
  },

  /**
   * 创建模拟错误Promise
   */
  createMockErrorPromise: (error: Error, delay: number = 0): Promise<never> => {
    return new Promise((_, reject) => {
      setTimeout(() => reject(error), delay);
    });
  },
};

// 全局测试生命周期
beforeAll(() => {
  // 测试开始前的全局设置
  if (process.env.DEBUG_TESTS === 'true') {
    console.log('🧪 Starting test suite with debug mode enabled');
  }
});

afterEach(() => {
  // 每个测试后的清理
  vi.clearAllMocks();
  vi.clearAllTimers();
});

// 导出测试工具
export { testUtils };
