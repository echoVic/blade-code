/**
 * 工具系统工厂函数
 * 提供便捷的工具系统创建和配置方法
 */

import { getBuiltinTools } from './builtin/index.js';
import { ExecutionPipeline } from './execution/ExecutionPipeline.js';
import { ToolDiscovery } from './registry/ToolDiscovery.js';
import { ToolRegistry } from './registry/ToolRegistry.js';

/**
 * 工具管理器配置
 */
export interface ToolManagerConfig {
  /** 是否启用调试模式 */
  debug?: boolean;
  /** 最大并发执行数 */
  maxConcurrency?: number;
  /** 执行超时时间（毫秒） */
  executionTimeout?: number;
  /** 是否记录执行历史 */
  logHistory?: boolean;
  /** 历史记录最大数量 */
  maxHistorySize?: number;
}

/**
 * 创建完整的工具管理器
 * 包含注册表、执行管道和发现服务
 */
export async function createToolManager(
  config: ToolManagerConfig = {},
  includeBuiltinTools: boolean = true
): Promise<{
  registry: ToolRegistry;
  pipeline: ExecutionPipeline;
  discovery: ToolDiscovery;
}> {
  // 创建核心组件
  const registry = new ToolRegistry();
  const pipeline = new ExecutionPipeline(registry, {
    maxHistorySize: config.maxHistorySize || 1000,
  });
  const discovery = new ToolDiscovery();

  // 注册内置工具
  if (includeBuiltinTools) {
    const builtinTools = await getBuiltinTools();
    if (builtinTools.length > 0) {
      registry.registerAll(builtinTools);
    }
  }

  return {
    registry,
    pipeline,
    discovery,
  };
}
