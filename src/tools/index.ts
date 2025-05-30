// 工具系统核心模块
export * from './ToolManager.js';
export * from './types.js';
export * from './validator.js';

// 类型定义
export type {
  ToolCallRequest,
  ToolCallResponse,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionHistory,
  ToolExecutionResult,
  ToolManagerConfig,
  ToolParameterSchema,
  ToolRegistrationOptions,
} from './types.js';

// 错误类型
export { ToolExecutionError, ToolRegistrationError, ToolValidationError } from './types.js';

// 内置工具
export {
  fileSystemTools,
  gitTools,
  networkTools,
  smartTools,
  textProcessingTools,
  utilityTools,
} from './builtin/index.js';

// 工具管理器工厂函数
import { ToolManager } from './ToolManager.js';
import {
  fileSystemTools,
  gitTools,
  networkTools,
  smartTools,
  textProcessingTools,
  utilityTools,
} from './builtin/index.js';
import type { ToolDefinition, ToolManagerConfig } from './types.js';

/**
 * 创建工具管理器并注册内置工具
 */
export async function createToolManager(
  config: ToolManagerConfig = {},
  includeBuiltinTools: boolean = true
): Promise<ToolManager> {
  const toolManager = new ToolManager(config);

  if (includeBuiltinTools) {
    // 注册所有内置工具
    const allBuiltinTools: ToolDefinition[] = [
      ...textProcessingTools,
      ...fileSystemTools,
      ...networkTools,
      ...utilityTools,
      ...gitTools,
      ...smartTools,
    ];

    for (const tool of allBuiltinTools) {
      await toolManager.registerTool(tool);
    }
  }

  return toolManager;
}

/**
 * 按分类获取内置工具
 */
export function getBuiltinToolsByCategory(): Record<string, ToolDefinition[]> {
  return {
    text: textProcessingTools,
    filesystem: fileSystemTools,
    network: networkTools,
    utility: utilityTools,
    git: gitTools,
    smart: smartTools,
  };
}

/**
 * 获取所有内置工具
 */
export function getAllBuiltinTools(): ToolDefinition[] {
  return [
    ...textProcessingTools,
    ...fileSystemTools,
    ...networkTools,
    ...utilityTools,
    ...gitTools,
    ...smartTools,
  ];
}
