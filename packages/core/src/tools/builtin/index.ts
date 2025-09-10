/**
 * 内置工具模块
 * 第二阶段：核心工具实现完成 - 文件操作和搜索工具
 */

import type { DeclarativeTool } from '../base/index.js';

// 文件操作工具
import { ReadTool, WriteTool, EditTool, MultiEditTool } from './file/index.js';

// 搜索工具
import { GlobTool, GrepTool, FindTool } from './search/index.js';

/**
 * 获取所有内置工具
 * 第二阶段：文件操作和搜索工具
 */
export async function getBuiltinTools(): Promise<DeclarativeTool[]> {
  return [
    // 文件操作工具
    new ReadTool(),
    new WriteTool(),
    new EditTool(),
    new MultiEditTool(),
    
    // 搜索工具
    new GlobTool(),
    new GrepTool(),
    new FindTool(),
  ];
}

/**
 * 按分类获取内置工具
 */
export async function getBuiltinToolsByCategory(category: string): Promise<DeclarativeTool[]> {
  const allTools = await getBuiltinTools();
  return allTools.filter(tool => tool.category === category);
}

/**
 * 按工具类型获取内置工具
 */
export async function getBuiltinToolsByType(): Promise<Record<string, DeclarativeTool[]>> {
  return {
    file: [
      new ReadTool(),
      new WriteTool(), 
      new EditTool(),
      new MultiEditTool(),
    ],
    search: [
      new GlobTool(),
      new GrepTool(),
      new FindTool(),
    ],
    // 第三阶段将添加：
    // shell: [],
    // web: [],
    // task: []
  };
}
