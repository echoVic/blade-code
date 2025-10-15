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

// 文件系统模拟
vi.mock('fs', () => ({
  ...vi.importActual('fs'),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    rm: vi.fn(),
  },
}));

// 路径模块模拟
vi.mock('path', () => ({
  ...vi.importActual('path'),
  default: {
    join: vi.fn((...args) => args.join('/')),
    resolve: vi.fn((...args) => args.join('/')),
    dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/')),
    basename: vi.fn((path) => path.split('/').pop() || ''),
    extname: vi.fn((path) => {
      const lastDot = path.lastIndexOf('.');
      return lastDot === -1 ? '' : path.slice(lastDot);
    }),
  },
  join: vi.fn((...args) => args.join('/')),
  resolve: vi.fn((...args) => args.join('/')),
  dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/')),
  basename: vi.fn((path) => path.split('/').pop() || ''),
  extname: vi.fn((path) => {
    const lastDot = path.lastIndexOf('.');
    return lastDot === -1 ? '' : path.slice(lastDot);
  }),
}));

// 子进程模拟
vi.mock('child_process', () => ({
  ...vi.importActual('child_process'),
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  fork: vi.fn(),
  execFile: vi.fn(),
}));

// 网络请求模拟
vi.mock('axios', () => ({
  ...vi.importActual('axios'),
  create: vi.fn(() => ({
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
  })),
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
}));

// WebSocket模拟
vi.mock('ws', () => ({
  ...vi.importActual('ws'),
  WebSocket: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
}));

// HTTP/HTTPS模拟
vi.mock('http', () => ({
  ...vi.importActual('http'),
  createServer: vi.fn(),
  request: vi.fn(),
  get: vi.fn(),
}));

vi.mock('https', () => ({
  ...vi.importActual('https'),
  createServer: vi.fn(),
  request: vi.fn(),
  get: vi.fn(),
}));

// 加密模块模拟
vi.mock('crypto', () => ({
  ...vi.importActual('crypto'),
  randomBytes: vi.fn(() => Buffer.from('mock-random-bytes')),
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'mock-hash'),
  })),
  createHmac: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'mock-hmac'),
  })),
}));

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
