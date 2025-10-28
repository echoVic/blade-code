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
 */
export const loadConfiguration: MiddlewareFunction = (argv) => {
  // 处理设置源
  if (typeof argv.settingSources === 'string') {
    const sources = argv.settingSources.split(',').map((s) => s.trim());
    console.log(`Loading configuration from: ${sources.join(', ')}`);
  }

  // 验证会话选项
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
    console.warn(
      '⚠️  Warning: stream-json input format may not work as expected with --print'
    );
  }
};
