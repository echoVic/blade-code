/**
 * 内置工具模块
 */

import * as os from 'os';
import * as path from 'path';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import type { Tool } from '../types/index.js';
// 文件操作工具
import { editTool, readTool, writeTool } from './file/index.js';
// Config 工具
import { configTool } from './config/index.js';
// Memory 工具
import { memoryReadTool, memoryWriteTool } from './memory/index.js';
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
import {
  askUserQuestionTool,
  skillTool,
  slashCommandTool,
  toolSearchTool,
} from './system/index.js';
// 任务管理工具
import { createTaskListTools, taskOutputTool, taskTool } from './task/index.js';
// Agent Team 工具
import { createTeamTools } from './team/index.js';
// 网络工具
import { webFetchTool, webSearchTool } from './web/index.js';
// Worktree 隔离工具
import { createWorktreeTools } from './worktree/index.js';

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

    // 子代理任务: Task, TaskOutput
    taskTool,
    taskOutputTool,

    // 会话任务列表: TaskCreate, TaskGet, TaskUpdate, TaskList
    ...createTaskListTools({ sessionId, configDir }),

    // Agent Teams: TeamCreate, TeamStatus, TeamDelete
    ...createTeamTools({ sessionId, configDir }),

    // Worktree isolation: EnterWorktree, ExitWorktree
    ...createWorktreeTools({ sessionId }),

    // Plan 模式: EnterPlanMode, ExitPlanMode
    enterPlanModeTool,
    exitPlanModeTool,

    // Spec 模式: EnterSpecMode, UpdateSpec, GetSpecContext, TransitionSpecPhase, ValidateSpec, ExitSpecMode
    ...specTools,

    // System: AskUserQuestion, Skill, SlashCommand, ToolSearch
    askUserQuestionTool,
    skillTool,
    slashCommandTool,
    toolSearchTool,

    // Memory: MemoryRead, MemoryWrite
    memoryReadTool,
    memoryWriteTool,

    // Config: ConfigTool
    configTool,
  ] as Tool[];

  // 添加 MCP 协议工具
  const mcpTools = await getMcpTools();

  return [...builtinTools, ...mcpTools];
}
