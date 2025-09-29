import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,babel}.config.*',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/test/**',
        '**/__tests__/**',
        '**/*.{test,spec}.{js,ts,jsx,tsx}',
        '**/scripts/**',
        '**/coverage/**',
      ],
    },
    setupFiles: ['./tests/setup.ts'],
    // 添加TypeScript配置
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
