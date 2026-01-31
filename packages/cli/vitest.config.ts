import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/test/**',
        '**/tests/**',
        '**/__tests__/**',
        '**/*.{test,spec}.{js,ts,jsx,tsx}',
        '**/scripts/**',
        '**/coverage/**',
        '**/examples/**',
        '**/docs/**',
        '**/*.config.*',
        'src/blade.tsx',
        'src/index.ts',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        global: {
          branches: 0,
          functions: 0,
          lines: 0,
          statements: 0,
        },
      },
    },
    reporters: ['verbose'],
    env: {
      NODE_ENV: 'test',
      TEST_MODE: 'true',
    },
    // 全局池配置
    poolOptions: {
      threads: {
        singleThread: false,
        maxThreads: 4,
        minThreads: 1,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/setup.ts'],
          typecheck: {
            tsconfig: './tsconfig.json',
          },
          testTimeout: 15000,
          hookTimeout: 15000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          poolOptions: {
            threads: {
              singleThread: true,
            },
          },
        },
      },
      {
        test: {
          name: 'cli',
          include: ['tests/cli/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          poolOptions: {
            threads: {
              singleThread: true,
            },
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@tests': resolve(__dirname, 'tests'),
      '@fixtures': resolve(__dirname, 'tests/fixtures'),
    },
  },
});
