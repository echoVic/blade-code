/**
 * 内置工具模块
 * 第二、三阶段完整实现：文件操作、搜索、命令执行、网络、任务管理工具
 */

import type { Tool } from '../types/index.js';

// 文件操作工具 - 新版本（基于 Zod）
import { editTool, multiEditTool, readTool, writeTool } from './file/index.js';

// 搜索工具 - 新版本（基于 Zod）
import { findTool, globTool, grepTool } from './search/index.js';

// Shell 命令工具 - 新版本（基于 Zod）
import { bashTool, scriptTool, shellTool } from './shell/index.js';
// 任务管理工具 - 新版本（基于 Zod）
import { taskTool } from './task/index.js';
// 网络工具 - 新版本（基于 Zod）
import { apiCallTool, webFetchTool } from './web/index.js';

/**
 * 获取MCP协议工具
 */
export async function getMcpTools(): Promise<Tool[]> {
  try {
    const { McpRegistry } = await import('../../mcp/index.js');
    const mcpRegistry = McpRegistry.getInstance();
    return await mcpRegistry.getAvailableTools();
  } catch (error) {
    console.warn('MCP协议工具加载失败:', error);
    return [];
  }
}

/**
 * 获取所有内置工具
 * 完整的第二、三、四阶段工具集合（含MCP协议工具）
 */
export async function getBuiltinTools(): Promise<Tool[]> {
  const builtinTools: Tool[] = [
    // 文件操作工具
    readTool,
    editTool,
    writeTool,
    multiEditTool,

    // 搜索工具
    globTool,
    grepTool,
    findTool,

    // Shell 命令工具
    bashTool,
    shellTool,
    scriptTool,

    // 网络工具
    webFetchTool,
    apiCallTool,

    // 任务管理工具
    taskTool,
  ];

  // 添加MCP协议工具
  const mcpTools = await getMcpTools();

  return [...builtinTools, ...mcpTools];
}

/**
 * 按分类获取内置工具
 */
export async function getBuiltinToolsByCategory(category: string): Promise<Tool[]> {
  const allTools = await getBuiltinTools();
  return allTools.filter((tool) => tool.category === category);
}

/**
 * 按工具类型获取内置工具
 */
export async function getBuiltinToolsByType(): Promise<Record<string, Tool[]>> {
  const mcpTools = await getMcpTools();

  return {
    file: [readTool, writeTool, editTool, multiEditTool],
    search: [globTool, grepTool, findTool],
    shell: [bashTool, shellTool, scriptTool],
    web: [webFetchTool, apiCallTool],
    task: [taskTool],
    mcp: mcpTools, // MCP协议外部工具
  };
}
