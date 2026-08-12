import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

const rootNodeModules = resolve(__dirname, '../../../node_modules');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: [resolve(__dirname, '../tests/support/setup.ts')],
    pool: 'threads',
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: 4,
    testTimeout: 15000,
    hookTimeout: 15000,
    server: {
      deps: {
        inline: true,
      },
    },
    typecheck: {
      tsconfig: './tsconfig.json',
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand'],
    alias: [
      {
        find: /^react$/,
        replacement: resolve(rootNodeModules, 'react/index.js'),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolve(rootNodeModules, 'react/jsx-runtime.js'),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolve(rootNodeModules, 'react/jsx-dev-runtime.js'),
      },
      {
        find: /^react-dom$/,
        replacement: resolve(rootNodeModules, 'react-dom/index.js'),
      },
      {
        find: /^react-dom\/client$/,
        replacement: resolve(rootNodeModules, 'react-dom/client.js'),
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: resolve(rootNodeModules, 'react-dom/test-utils.js'),
      },
      {
        find: /^react-remove-scroll$/,
        replacement: resolve(
          rootNodeModules,
          'react-remove-scroll/dist/es2019/index.js'
        ),
      },
      {
        find: /^react-remove-scroll-bar$/,
        replacement: resolve(
          rootNodeModules,
          'react-remove-scroll-bar/dist/es2019/index.js'
        ),
      },
      {
        find: /^react-style-singleton$/,
        replacement: resolve(
          rootNodeModules,
          'react-style-singleton/dist/es2019/index.js'
        ),
      },
      {
        find: /^use-callback-ref$/,
        replacement: resolve(rootNodeModules, 'use-callback-ref/dist/es2019/index.js'),
      },
      {
        find: /^use-sidecar$/,
        replacement: resolve(rootNodeModules, 'use-sidecar/dist/es2019/index.js'),
      },
      {
        find: '@api',
        replacement: resolve(__dirname, '../src/api'),
      },
      {
        find: '@',
        replacement: resolve(__dirname, 'src'),
      },
    ],
  },
});
