import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // 单元测试配置
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      environment: 'node',
      testTimeout: 10000,
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: false,
          maxThreads: 4,
        },
      },
    },
  },
  // 集成测试配置
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      environment: 'node',
      testTimeout: 30000,
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true, // 集成测试建议串行执行
        },
      },
      retry: 1,
    },
  },
  // E2E测试配置
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      environment: 'node',
      testTimeout: 60000,
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true, // E2E测试建议串行执行
        },
      },
      retry: 1,
    },
  },
  // 安全测试配置
  {
    test: {
      name: 'security',
      include: ['tests/security/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      environment: 'node',
      testTimeout: 20000,
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true, // 安全测试建议串行执行
        },
      },
      retry: 1,
    },
  },
]);
