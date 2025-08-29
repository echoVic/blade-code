/**
 * 优化的构建配置文件
 * 支持增量构建、代码分割和缓存优化
 */

import { defineConfig } from 'tsup';
import { createIncrementalBuilder } from './IncrementalBuildManager.js';

// 入口点配置
const entryPoints = [
  'src/index.ts',
  'src/agent/index.ts',
  'src/llm/index.ts',
  'src/tools/index.ts',
  'src/ui/index.ts',
  'src/commands/index.ts',
];

// 外部依赖配置
const externalDeps = [
  'react',
  'react-dom',
  'ink',
  'commander',
  'axios',
  'ws',
  'openai',
  '@modelcontextprotocol/sdk',
];

// 共享的tsup配置
const sharedConfig = defineConfig({
  format: ['esm'],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  esbuildOptions: (options) => {
    // 启用更多优化
    options.minify = true;
    options.keepNames = false;
    options.define = {
      'process.env.NODE_ENV': '"production"',
    };
  },
  treeshake: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
});

// 开发环境配置
const devConfig = defineConfig({
  ...sharedConfig,
  watch: {
    include: ['src/**/*'],
    exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  },
  onSuccess: async () => {
    console.log('构建完成，正在启动开发服务器...');
    // 可以在这里启动开发服务器
  },
  outDir: 'dist/dev',
});

// 生产环境配置
const prodConfig = defineConfig({
  ...sharedConfig,
  treeshake: {
    propertyReadSideEffects: false,
    unknownGlobalSideEffects: false,
  },
  external: externalDeps,
  async buildStart() {
    // 创建增量构建管理器
    const builder = createIncrementalBuilder(process.cwd());
    
    // 获取所有TypeScript文件
    const tsFiles = entryPoints.map(ep => ep.replace('src/', ''));
    
    // 分析构建需求
    const { analysis, tasks } = await builder.build(tsFiles);
    
    console.log(`检测到 ${analysis.changes.size} 个变更文件`);
    console.log(`生成 ${tasks.length} 个构建任务`);
    
    if (analysis.rebuildRequired) {
      console.log('执行完整重建...');
    } else {
      console.log(`受影响的文件数: ${analysis.affectedFiles.size}`);
      console.log('执行增量构建...');
    }
  },
  outDir: 'dist/prod',
  banner: {
    js: [
      '/*',
      ' * Blade CLI v' + process.env.npm_package_version,
      ' * Built using tsup with incremental optimization',
      ' * Copyright (c) ' + new Date().getFullYear(),
      ' */',
    ].join('\n'),
  },
});

// 性能分析配置
const analyzeConfig = defineConfig({
  ...devConfig,
  outDir: 'dist/analyze',
  esbuildPlugins: [
    {
      name: 'bundle-analyzer',
      setup(build) {
        // 在这里可以集成bundle分析器
        build.onEnd((result) => {
          if (result.metafile) {
            console.log('构建分析结果:', result.metafile);
          }
        });
      },
    },
  ],
});

// 导出所有配置
export default defineConfig((ctx) => {
  if (ctx.mode === 'development') {
    return devConfig(entryPoints);
  } else if (ctx.mode === 'production') {
    return prodConfig(entryPoints);
  } else if (ctx.mode === 'analyze') {
    return analyzeConfig(entryPoints);
  }
  
  return devConfig(entryPoints);
});

// 代码条带配置（用于大型应用）
const chunkConfigs = {
  // React相关模块
  reactChunk: {
    entry: {
      'ui-components': 'src/ui/index.ts',
    },
    external: [...externalDeps],
  },
  
  // LLM相关模块
  llmChunk: {
    entry: {
      llm: 'src/llm/index.ts',
    },
    external: externalDeps.filter(dep => !dep.includes('openai')),
  },
  
  // 工具相关模块
  toolsChunk: {
    entry: {
      tools: 'src/tools/index.ts',
    },
    external: externalDeps,
  },
  
  // 命令行工具
  cliChunk: {
    entry: {
      blade: 'src/index.ts',
    },
    format: ['esm'],
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
};

// 预构建配置（用于依赖预编译）
const preBundleConfig = defineConfig({
  deps: {
    inline: [],
    external: externalDeps,
  },
  format: 'esm',
  splitting: true,
  outDir: 'node_modules/.blade-deps',
});

// 开发服务器配置
const devServerConfig = {
  port: 3000,
  middleware: [
    // 可以添加自定义中间件
  ],
  proxy: {
    // 可以添加代理配置
  },
  static: {
    directory: 'dist/dev',
  },
};

// 监控配置
const monitoringConfig = {
  enabled: process.env.BLADE_MONITORING === 'true',
  metrics: {
    buildTime: true,
    bundleSize: true,
    dependencies: true,
    assets: true,
  },
  thresholds: {
    buildTime: 30000, // 30秒
    bundleSize: {
      warning: 1024 * 1024, // 1MB
      error: 5 * 1024 * 1024, // 5MB
    },
    assets: {
      maxAssets: 50,
      maxSize: 512 * 1024, // 512KB
    },
  },
  reporting: {
    format: ['console', 'json'],
    output: 'dist/build-report.json',
  },
};

// 导出工具函数
export {
  entryPoints,
  externalDeps,
  chunkConfigs,
  preBundleConfig,
  devServerConfig,
  monitoringConfig,
};