import { afterEach, vi } from 'vitest';

// Mock axios for security tests
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  const mockAxios = {
    ...actual,
    create: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ data: {} }),
      post: vi.fn().mockResolvedValue({ data: {} }),
      put: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { default: mockAxios };
});

// Mock child_process for command execution
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    execFile: vi.fn((cmd, args, callback) => {
      if (callback) {
        callback(null, { stdout: 'mock output', stderr: '' }, 'mock output');
      }
    }),
    spawn: vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event, callback) => {
        if (event === 'close') callback(0);
      }),
      kill: vi.fn(),
    })),
  };
});

// Mock fs for file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      access: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
      unlink: vi.fn(),
      rmdir: vi.fn(),
    },
  };
});

// Global test cleanup
afterEach(() => {
  vi.clearAllMocks();
});
