import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';
const isReleaseRealApiMatrix = process.env.REAL_API_RELEASE_MATRIX === '1';
const threadPool = {
  pool: 'threads' as const,
  fileParallelism: !isCI,
  maxWorkers: isCI ? 1 : 4,
  minWorkers: 1,
};
const forkPool = {
  pool: 'forks' as const,
  fileParallelism: !isCI,
  maxWorkers: isCI ? 1 : 4,
  minWorkers: 1,
};

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
    ...threadPool,
    isolate: true,
    projects: [
      {
        test: {
          name: 'unit',
          ...threadPool,
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
          ...forkPool,
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
          include: ['tests/integration/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          exclude: ['tests/integration/real-api/**', 'tests/integration/cli/**'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'cli',
          ...threadPool,
          include: ['tests/integration/cli/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'e2e',
          ...forkPool,
          include: ['tests/e2e/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts', './tests/support/setup.e2e.ts'],
          testTimeout: 60000,
          hookTimeout: 60000,
        },
      },
      {
        test: {
          name: 'performance',
          ...threadPool,
          include: ['tests/performance/**/*.{test,spec,bench}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
      {
        test: {
          name: 'snapshot',
          ...threadPool,
          include: ['tests/snapshots/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 15000,
          hookTimeout: 15000,
        },
      },
      {
        test: {
          name: 'security',
          ...forkPool,
          include: ['tests/security/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'real-api',
          ...forkPool,
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
          include: ['tests/integration/real-api/**/*.{test,spec}.{js,ts,jsx,tsx}'],
          setupFiles: ['./tests/support/setup.real-api.ts'],
          retry: isReleaseRealApiMatrix ? 0 : 1,
          testTimeout: 300000,
          hookTimeout: 300000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@tests': resolve(import.meta.dirname, 'tests'),
      '@fixtures': resolve(import.meta.dirname, 'tests/support/fixtures'),
      '@mocks': resolve(import.meta.dirname, 'tests/support/mocks'),
      '@helpers': resolve(import.meta.dirname, 'tests/support/helpers'),
      '@factories': resolve(import.meta.dirname, 'tests/support/factories'),
      '@support': resolve(import.meta.dirname, 'tests/support'),
    },
  },
});
