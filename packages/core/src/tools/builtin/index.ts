/**
 * 内置工具模块
 * 第二、三阶段完整实现：文件操作、搜索、命令执行、网络、任务管理工具
 */

import type { DeclarativeTool } from '../base/index.js';

// 文件操作工具
import { EditTool, MultiEditTool, ReadTool, WriteTool } from './file/index.js';

// 搜索工具
import { FindTool, GlobTool, GrepTool } from './search/index.js';

// Shell命令工具
import { BashTool, ScriptTool, ShellTool } from './shell/index.js';

// 网络工具
import { ApiCallTool, WebFetchTool } from './web/index.js';

// 任务管理工具
import { TaskTool } from './task/index.js';

/**
 * 获取所有内置工具
 * 完整的第二、三阶段工具集合
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

    // Shell命令工具
    new ShellTool(),
    new BashTool(),
    new ScriptTool(),

    // 网络工具
    new WebFetchTool(),
    new ApiCallTool(),

    // 任务管理工具
    new TaskTool(),
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
    file: [new ReadTool(), new WriteTool(), new EditTool(), new MultiEditTool()],
    search: [new GlobTool(), new GrepTool(), new FindTool()],
    shell: [new ShellTool(), new BashTool(), new ScriptTool()],
    web: [new WebFetchTool(), new ApiCallTool()],
    task: [new TaskTool()],
  };
}
