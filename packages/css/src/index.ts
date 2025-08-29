/**
 * Blade AI CLI Export
 * 命令行界面统一导出
 */

// 命令
export * from './commands/index.js';

// UI 组件
export * from './ui/index.js';

// 入口函数
import { Agent } from '@blade-ai/core';

/**
 * 创建 Blade CLI 实例
 */
export function createBladeCLI(config?: Parameters<typeof Agent>[0]) {
  const agent = new Agent(config);
  return {
    agent,
    getAgent: () => agent,
  };
}