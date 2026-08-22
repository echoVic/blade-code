#!/usr/bin/env node

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { testTypes } from './test-config.js';
import {
  createTestProcessEnvironment,
  removeOwnedTestTemporaryRoot,
  reportTestTemporaryRootCleanupFailure,
} from './test-environment.js';
import { runOwnedCommand } from './test-runner.js';
import { resolveVitestCli } from './vitest-cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log(`
🧪 Blade 测试运行器

用法:
  npm run test [类型] [选项]

测试类型:
  unit        运行单元测试
  integration 运行集成测试
  realApi     运行真实 API 与生产 Agent 轨迹测试
  realApiQualification 运行发布阻断真实 API 轨迹
  cli         运行 CLI 行为测试
  headlessCore 运行 headless 与核心 runtime 回归测试
  e2e         运行端到端测试
  performance 运行性能测试
  snapshot    运行快照测试
  security    运行安全测试
  all         运行所有项目

选项:
  --coverage  生成覆盖率报告
  --watch     监听模式运行测试
  --debug     启用调试模式
  --verbose   详细输出
  --update    更新快照
  --help      显示此帮助信息

示例:
  npm run test unit
  npm run test integration --coverage
  npm run test realApi
  npm run test all --watch
  npm run test cli --debug
  npm run test snapshot --update
  npm run test security
`);
}

async function runTest(testType, options = {}) {
  const config = testTypes[testType];
  if (!config) {
    console.error(`❌ 未知的测试类型: ${testType}`);
    printUsage();
    process.exit(1);
  }

  console.log(`🚀 开始运行${config.name}...`);

  if (config.env) {
    Object.assign(process.env, config.env);
  }

  if (options.watch && options.coverage) {
    console.warn('⚠️ 监听模式暂不支持覆盖率统计，忽略 --coverage');
    options.coverage = false;
  }

  const baseArgs = [];
  if (options.watch) {
    baseArgs.push('--watch');
  } else {
    baseArgs.push('run');
  }

  baseArgs.push('--config', path.join(__dirname, '..', 'vitest.config.ts'));

  if (config.project) {
    baseArgs.push('--project', config.project);
  }

  if (options.coverage && config.coverageExcludedProjects) {
    baseArgs.push(
      ...config.coverageExcludedProjects.map(project => `--project=!${project}`)
    );
  }

  if (config.files) {
    baseArgs.push(...config.files.map(f => path.resolve(__dirname, '..', f)));
  }

  if (options.coverage) {
    baseArgs.push('--coverage');
  }

  if (options.update) {
    baseArgs.push('--update');
  }

  if (options.debug) {
    process.env.DEBUG_TESTS = 'true';
  }

  if (options.verbose) {
    process.env.VERBOSE_TESTS = 'true';
  }

  const vitestPath = resolveVitestCli();
  const displayCommand = ['vitest', ...baseArgs].join(' ');
  const controller = new AbortController();
  let interruptedBy;
  const interrupt = (signal) => {
    interruptedBy ??= signal;
    controller.abort();
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const testTemporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'blade-test-process-')
  );
  let runError;

  try {
    console.log(`📝 执行命令: ${displayCommand}`);

    const startTime = Date.now();
    const testEnvironment = createTestProcessEnvironment(
      process.env,
      testTemporaryRoot
    );
    const result = await runOwnedCommand({
      command: process.execPath,
      args: [vitestPath, ...baseArgs],
      cwd: process.cwd(),
      env: testEnvironment,
      timeoutMs: config.timeout,
      signal: controller.signal,
    });

    if (interruptedBy) {
      throw new Error(`测试运行被 ${interruptedBy} 中断`);
    }
    if (result.timedOut) {
      throw new Error(`测试运行超过 ${config.timeout}ms，已终止完整进程树`);
    }
    if (result.signal) {
      throw new Error(`测试进程被 ${result.signal} 终止`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`测试进程退出码: ${result.exitCode ?? 1}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ ${config.name}完成! 耗时: ${duration}s`);
  } catch (error) {
    runError = error;
    console.error(`❌ ${config.name}失败:`, error.message);
    process.exitCode = interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    try {
      await removeOwnedTestTemporaryRoot(testTemporaryRoot);
    } catch (cleanupError) {
      reportTestTemporaryRootCleanupFailure(runError, cleanupError, (message, error) => {
        console.error(
          `❌ ${message}:`,
          error instanceof Error ? error.message : String(error)
        );
      });
      process.exitCode ||= 1;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    return;
  }
  
  const testType = args[0];
  const options = {
    coverage: args.includes('--coverage'),
    watch: args.includes('--watch'),
    debug: args.includes('--debug'),
    verbose: args.includes('--verbose'),
    update: args.includes('--update'),
  };
  
  if (!testTypes[testType]) {
    console.error(`❌ 未知的测试类型: ${testType}`);
    printUsage();
    process.exit(1);
  }
  
  await runTest(testType, options);
}

process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的Promise拒绝:', reason);
  process.exit(1);
});

await main();
