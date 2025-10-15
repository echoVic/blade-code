#!/usr/bin/env node

/**
 * 测试运行脚本
 * 支持运行不同类型的测试：unit, integration, e2e, security, all
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testTypes = {
  unit: {
    name: '单元测试',
    command: 'vitest run tests/unit',
    timeout: 30000,
  },
  integration: {
    name: '集成测试',
    command: 'vitest run tests/integration',
    timeout: 60000,
  },
  e2e: {
    name: '端到端测试',
    command: 'vitest run tests/e2e',
    timeout: 120000,
  },
  security: {
    name: '安全测试',
    command: 'vitest run tests/security',
    timeout: 60000,
  },
  all: {
    name: '所有测试',
    command: 'vitest run --config vitest.config.ts',
    timeout: 180000,
  },
};

const coverageTypes = {
  unit: 'vitest run tests/unit --coverage',
  integration: 'vitest run tests/integration --coverage',
  all: 'vitest run --config vitest.config.ts --coverage',
};

function printUsage() {
  console.log(`
🧪 Blade 测试运行器

用法:
  npm run test [类型] [选项]

测试类型:
  unit        运行单元测试
  integration 运行集成测试
  e2e         运行端到端测试
  security    运行安全测试
  all         运行所有测试

选项:
  --coverage  生成覆盖率报告
  --watch     监听模式运行测试
  --debug     启用调试模式
  --verbose   详细输出
  --help      显示此帮助信息

示例:
  npm run test unit
  npm run test integration --coverage
  npm run test all --watch
  npm run test e2e --debug
`);
}

function runTest(testType, options = {}) {
  const config = testTypes[testType];
  if (!config) {
    console.error(`❌ 未知的测试类型: ${testType}`);
    printUsage();
    process.exit(1);
  }

  console.log(`🚀 开始运行${config.name}...`);
  
  let command = config.command;
  
  // 添加选项
  if (options.coverage) {
    command = coverageTypes[testType] || command + ' --coverage';
  }
  
  if (options.watch) {
    command = command.replace('run', '');
  }
  
  if (options.debug) {
    process.env.DEBUG_TESTS = 'true';
  }
  
  if (options.verbose) {
    process.env.VERBOSE_TESTS = 'true';
  }

  try {
    console.log(`📝 执行命令: ${command}`);
    
    const startTime = Date.now();
    execSync(command, {
      stdio: 'inherit',
      cwd: process.cwd(),
      timeout: config.timeout,
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ ${config.name}完成! 耗时: ${duration}s`);
    
  } catch (error) {
    console.error(`❌ ${config.name}失败:`, error.message);
    process.exit(1);
  }
}

function main() {
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
  };
  
  // 验证测试类型
  if (!testTypes[testType]) {
    console.error(`❌ 未知的测试类型: ${testType}`);
    printUsage();
    process.exit(1);
  }
  
  runTest(testType, options);
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的Promise拒绝:', reason);
  process.exit(1);
});

main();
