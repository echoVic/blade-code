import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'lcov'],
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
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
    reporters: ['verbose'],
    env: {
      NODE_ENV: 'test',
      TEST_MODE: 'true',
    },
    pool: process.env.CI === 'true' ? 'forks' : 'threads',
    poolOptions: {
      threads: {
        singleThread: process.env.CI === 'true',
        maxThreads: process.env.CI === 'true' ? 1 : 4,
        minThreads: 1,
      },
      forks: {
        singleFork: true,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
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
          setupFiles: ['./tests/support/setup.ts'],
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
          include: ['tests/integration/cli/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
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
          name: 'e2e',
          include: ['tests/e2e/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts', './tests/support/setup.e2e.ts'],
          testTimeout: 60000,
          hookTimeout: 60000,
          poolOptions: {
            threads: {
              singleThread: true,
            },
          },
        },
      },
      {
        test: {
          name: 'performance',
          include: ['tests/performance/**/*.{test,spec,bench}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 120000,
          hookTimeout: 120000,
          poolOptions: {
            threads: {
              singleThread: true,
            },
          },
        },
      },
      {
        test: {
          name: 'snapshot',
          include: ['tests/snapshots/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 15000,
          hookTimeout: 15000,
        },
      },
      {
        test: {
          name: 'security',
          include: ['tests/security/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
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
      '@fixtures': resolve(__dirname, 'tests/support/fixtures'),
      '@mocks': resolve(__dirname, 'tests/support/mocks'),
      '@helpers': resolve(__dirname, 'tests/support/helpers'),
      '@factories': resolve(__dirname, 'tests/support/factories'),
      '@support': resolve(__dirname, 'tests/support'),
    },
  },
});
