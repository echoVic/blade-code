/**
 * 内置工具模块
 * 暂时提供空的导出，后续在第二阶段实现具体工具
 */

import type { DeclarativeTool } from '../base/index.js';

/**
 * 获取所有内置工具
 * 第一阶段暂时返回空数组，第二阶段实现具体工具
 */
export async function getBuiltinTools(): Promise<DeclarativeTool[]> {
  return [];
}

/**
 * 按分类获取内置工具
 */
export async function getBuiltinToolsByCategory(category: string): Promise<DeclarativeTool[]> {
  const allTools = await getBuiltinTools();
  return allTools.filter(tool => tool.category === category);
}
