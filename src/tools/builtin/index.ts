/**
 * 内置工具模块
 * 第二、三阶段完整实现：文件操作、搜索、命令执行、网络、任务管理工具
 */

import { McpRegistry } from '@/mcp/McpRegistry.js';
import * as os from 'os';
import * as path from 'path';
import type { Tool } from '../types/index.js';
// 文件操作工具 - 新版本（基于 Zod）
import { editTool, multiEditTool, readTool, writeTool } from './file/index.js';
// Plan 工具
import { exitPlanModeTool } from './plan/index.js';
// 搜索工具 - 新版本（基于 Zod）
import { findTool, globTool, grepTool } from './search/index.js';
// Shell 命令工具 - 新版本（基于 Zod）
import { bashTool, scriptTool, shellTool } from './shell/index.js';
// 任务管理工具 - 新版本（基于 Zod）
import { taskTool } from './task/index.js';
// Todo工具 - 新版本（基于 Zod）
import { createTodoReadTool, createTodoWriteTool } from './todo/index.js';
// 网络工具 - 新版本（基于 Zod）
import { apiCallTool, webFetchTool } from './web/index.js';

/**
 * 获取MCP协议工具
 */
export async function getMcpTools(): Promise<Tool[]> {
  try {
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
export async function getBuiltinTools(opts?: {
  sessionId?: string;
  configDir?: string;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId || `session_${Date.now()}`;
  const configDir = opts?.configDir || path.join(os.homedir(), '.blade');

  const builtinTools = [
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

    // Todo工具
    createTodoWriteTool({ sessionId, configDir }),
    createTodoReadTool({ sessionId, configDir }),

    // 🆕 Plan 工具
    exitPlanModeTool,
  ] as Tool[];

  // 添加MCP协议工具
  const mcpTools = await getMcpTools();

  return [...builtinTools, ...mcpTools];
}
