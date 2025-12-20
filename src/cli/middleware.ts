import { ConfigManager } from '../config/index.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { getState } from '../store/vanilla.js';

const logger = createLogger(LogCategory.GENERAL);

/**
 * Yargs 中间件
 * 处理全局逻辑，如权限验证、配置加载等
 */

import type { MiddlewareFunction } from 'yargs';

/**
 * 权限验证中间件
 */
export const validatePermissions: MiddlewareFunction = (argv) => {
  // 处理 --yolo 快捷方式
  if (argv.yolo) {
    // 如果同时指定了 --yolo 和 --permission-mode，抛出错误
    if (argv.permissionMode && argv.permissionMode !== 'yolo') {
      throw new Error(
        'Cannot use both --yolo and --permission-mode with different values'
      );
    }
    // 将 --yolo 映射到 --permission-mode=yolo
    argv.permissionMode = 'yolo';
  }

  // 验证工具列表冲突
  if (Array.isArray(argv.allowedTools) && Array.isArray(argv.disallowedTools)) {
    const intersection = argv.allowedTools.filter((tool: string) =>
      (argv.disallowedTools as string[]).includes(tool)
    );
    if (intersection.length > 0) {
      throw new Error(
        `Tools cannot be both allowed and disallowed: ${intersection.join(', ')}`
      );
    }
  }
};

/**
 * 配置加载中间件
 * 所有命令（包括 UI 模式）都会执行，负责初始化 ConfigManager 和 Store
 */
export const loadConfiguration: MiddlewareFunction = async (argv) => {
  // 1. 初始化 ConfigManager 和 Store（所有命令共用）
  try {
    const configManager = ConfigManager.getInstance();
    const config = await configManager.initialize();
    getState().config.actions.setConfig(config);

    if (argv.debug) {
      logger.info('[CLI] 配置已加载到 Store');
    }
  } catch (error) {
    logger.error(
      '[CLI] ❌ 配置初始化失败',
      error instanceof Error ? error.message : error
    );
    console.error('\n❌ 配置初始化失败\n');
    console.error('原因:', error instanceof Error ? error.message : '未知错误');
    console.error('\n请检查：');
    console.error('  1. 配置文件格式是否正确 (~/.blade/config.json)');
    console.error('  2. 是否需要运行 blade 进行首次配置');
    console.error('  3. 配置文件权限是否正确\n');
    process.exit(1);
  }

  // 2. 验证会话选项
  if (argv.continue && argv.resume) {
    throw new Error('Cannot use both --continue and --resume flags simultaneously');
  }
};

/**
 * 输出格式验证中间件
 */
export const validateOutput: MiddlewareFunction = (argv) => {
  // 验证输出格式组合
  if (argv.outputFormat && argv.outputFormat !== 'text' && !argv.print) {
    throw new Error('--output-format can only be used with --print flag');
  }

  // 验证输入格式
  if (argv.inputFormat === 'stream-json' && argv.print) {
    logger.warn(
      '⚠️  Warning: stream-json input format may not work as expected with --print'
    );
  }
};
