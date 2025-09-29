import { TextDecoder, TextEncoder } from 'util';
import { vi } from 'vitest';

// 全局设置
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// 模拟 Node.js 的 fetch API
if (!global.fetch) {
  global.fetch = vi.fn();
}

// 模拟 console 方法，减少测试时的噪音
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = vi.fn((...args) => {
  if (process.env.DEBUG_TESTS === 'true') {
    originalConsoleLog(...args);
  }
});

console.warn = vi.fn((...args) => {
  if (process.env.DEBUG_TESTS === 'true') {
    originalConsoleWarn(...args);
  }
});

console.error = vi.fn((...args) => {
  if (process.env.DEBUG_TESTS === 'true') {
    originalConsoleError(...args);
  }
});

// 设置错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// 模拟文件系统
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
}));

// 模拟路径模块
vi.mock('path', () => ({
  ...vi.importActual('path'),
  join: vi.fn((...args) => args.join('/')),
  resolve: vi.fn((...args) => args.join('/')),
  dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/')),
  basename: vi.fn((path) => path.split('/').pop() || ''),
  extname: vi.fn((path) => {
    const lastDot = path.lastIndexOf('.');
    return lastDot === -1 ? '' : path.slice(lastDot);
  }),
}));

// 模拟子进程
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  fork: vi.fn(),
}));

// 模拟网络请求
vi.mock('axios', () => ({
  create: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    head: vi.fn(),
    options: vi.fn(),
  })),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  head: vi.fn(),
  options: vi.fn(),
}));

// 模拟 WebSocket
vi.mock('ws', () => ({
  WebSocket: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
}));

// 模拟环境变量
process.env.NODE_ENV = 'test';
process.env.DEBUG_TESTS = 'false';

// 设置测试特定的环境变量
process.env.TEST_MODE = 'true';
process.env.LOG_LEVEL = 'error';
