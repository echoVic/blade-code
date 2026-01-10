/**
 * 内置工具模块
 */

import * as os from 'os';
import * as path from 'path';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import type { Tool } from '../types/index.js';
// 文件操作工具
import { editTool, readTool, writeTool } from './file/index.js';
// Notebook 工具
import { notebookEditTool } from './notebook/index.js';
// Plan 工具
import { enterPlanModeTool, exitPlanModeTool } from './plan/index.js';
// 搜索工具
import { globTool, grepTool } from './search/index.js';
// Shell 命令工具
import { bashTool, killShellTool } from './shell/index.js';
// Spec 工具
import { specTools } from './spec/index.js';
// System 工具
import { askUserQuestionTool, skillTool, slashCommandTool } from './system/index.js';
// 任务管理工具
import { taskOutputTool, taskTool } from './task/index.js';
// Todo 工具
import { createTodoWriteTool } from './todo/index.js';
// 网络工具
import { webFetchTool, webSearchTool } from './web/index.js';

async function getMcpTools(): Promise<Tool[]> {
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
 */
export async function getBuiltinTools(opts?: {
  sessionId?: string;
  configDir?: string;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId || `session_${Date.now()}`;
  const configDir = opts?.configDir || path.join(os.homedir(), '.blade');

  const builtinTools = [
    // 文件操作工具: Read, Edit, Write, NotebookEdit
    readTool,
    editTool,
    writeTool,
    notebookEditTool,

    // 搜索工具: Glob, Grep
    globTool,
    grepTool,

    // Shell 工具: Bash, KillShell
    bashTool,
    killShellTool,

    // 网络工具: WebFetch, WebSearch
    webFetchTool,
    webSearchTool,

    // 任务管理: Task, TaskOutput
    taskTool,
    taskOutputTool,

    // Todo: TodoWrite
    createTodoWriteTool({ sessionId, configDir }),

    // Plan 模式: EnterPlanMode, ExitPlanMode
    enterPlanModeTool,
    exitPlanModeTool,

    // Spec 模式: EnterSpecMode, UpdateSpec, GetSpecContext, TransitionSpecPhase, ValidateSpec, ExitSpecMode
    ...specTools,

    // System: AskUserQuestion, Skill, SlashCommand
    askUserQuestionTool,
    skillTool,
    slashCommandTool,
  ] as Tool[];

  // 添加 MCP 协议工具
  const mcpTools = await getMcpTools();

  return [...builtinTools, ...mcpTools];
}
