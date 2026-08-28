/**
 * 内置工具模块
 */

import type { SessionAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../../agent/resources/WorkspaceModelResources.js';
import type { UserPromptArtifactStore } from '../../agent/runtime/UserPromptArtifactStore.js';
import {
  getSubagentRegistry,
  type SubagentRegistry,
} from '../../agent/subagents/SubagentRegistry.js';
import type { SessionBrowserRuntime } from '../../browser/SessionBrowserRuntime.js';
import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';
import type { LspSessionManager } from '../../lsp/LspSessionManager.js';
import type { SessionLspResources } from '../../lsp/WorkspaceLspResources.js';
import { getSkillRegistry, type SkillRegistry } from '../../skills/index.js';
import { CustomCommandRegistry } from '../../slash-commands/custom/CustomCommandRegistry.js';
import type { Tool } from '../types/index.js';
import { createBrowserTools } from './browser/index.js';
// Config 工具
import { configTool } from './config/index.js';
// 文件操作工具
import { applyPatchTool, editTool, readTool, writeTool } from './file/index.js';
// Goal 工具
import { createGoalTools } from './goal/index.js';
import { createLspTool } from './lsp/index.js';
// Memory 工具
import { memoryReadTool, memoryWriteTool } from './memory/index.js';
// Notebook 工具
import { notebookEditTool } from './notebook/index.js';
// Plan 工具
import { enterPlanModeTool, exitPlanModeTool } from './plan/index.js';
// 搜索工具
import { globTool, grepTool } from './search/index.js';
// Shell 命令工具
import { bashTool, killShellTool, writeStdinTool } from './shell/index.js';
// System 工具
import {
  askUserQuestionTool,
  createReadPromptArtifactTool,
  createSkillTool,
  createSlashCommandTool,
  toolSearchTool,
} from './system/index.js';
// 任务管理工具
import { createTaskListTools, createTaskTool, taskOutputTool } from './task/index.js';
// Agent Team 工具
import { createTeamTools } from './team/index.js';
// 网络工具
import { webFetchTool, webSearchTool } from './web/index.js';
// Worktree 隔离工具
import { createWorktreeTools } from './worktree/index.js';

/**
 * 获取所有内置工具
 */
export async function getBuiltinTools(opts?: {
  sessionId?: string;
  configDir?: string;
  workspaceRoot?: string;
  resourceRoot?: string;
  subagentRegistry?: SubagentRegistry;
  skillRegistry?: SkillRegistry;
  commandRegistry?: CustomCommandRegistry;
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspManager?: LspSessionManager;
  lspResources?: SessionLspResources;
  getReasoningEffort?: () => ReasoningEffortSelection;
  getServiceTier?: () => ServiceTierSelection;
  getResponseVerbosity?: () => ResponseVerbositySelection;
  getCommunicationStyle?: () => CommunicationStyleSelection;
  agentTeamsEnabled?: boolean;
  userPromptArtifactStore?: UserPromptArtifactStore;
  browserRuntime?: SessionBrowserRuntime;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId || `session_${Date.now()}`;
  const configDir = opts?.configDir || getBladeStorageRoot();
  const workspaceRoot = opts?.workspaceRoot || process.cwd();
  const resourceRoot = opts?.resourceRoot || workspaceRoot;
  const subagentRegistry =
    opts?.agentResources?.subagents ??
    opts?.subagentRegistry ??
    getSubagentRegistry(resourceRoot);
  const skillRegistry =
    opts?.agentResources?.skills ??
    opts?.skillRegistry ??
    getSkillRegistry({ cwd: resourceRoot });
  const commandRegistry =
    opts?.agentResources?.commands ??
    opts?.commandRegistry ??
    CustomCommandRegistry.getInstance(resourceRoot);

  const builtinTools = [
    // 文件操作工具: Read, Edit, Write, ApplyPatch, NotebookEdit
    readTool,
    editTool,
    writeTool,
    applyPatchTool,
    notebookEditTool,

    // 搜索工具: Glob, Grep
    globTool,
    grepTool,

    // Shell 工具: Bash, WriteStdin, KillShell
    bashTool,
    writeStdinTool,
    killShellTool,

    // 网络工具: WebFetch, WebSearch
    webFetchTool,
    webSearchTool,
    ...(opts?.browserRuntime ? createBrowserTools(opts.browserRuntime) : []),

    // 子代理任务: Task, TaskOutput
    createTaskTool(
      subagentRegistry,
      opts?.agentResources,
      opts?.modelResources,
      opts?.lspResources,
      opts?.getReasoningEffort,
      opts?.getServiceTier,
      opts?.getResponseVerbosity,
      opts?.getCommunicationStyle
    ),
    taskOutputTool,

    // 会话任务列表: TaskCreate, TaskGet, TaskUpdate, TaskList
    ...createTaskListTools({ sessionId, configDir }),

    // Goal mode: GetGoal, CreateGoal, UpdateGoal
    ...createGoalTools({ sessionId, workspaceRoot, configDir }),

    // Agent Teams are a formal capability gated by explicit configuration.
    ...(opts?.agentTeamsEnabled
      ? createTeamTools({
          sessionId,
          configDir,
          subagentRegistry,
          agentResources: opts?.agentResources,
          modelResources: opts?.modelResources,
          lspResources: opts?.lspResources,
          getReasoningEffort: opts?.getReasoningEffort,
          getServiceTier: opts?.getServiceTier,
          getResponseVerbosity: opts?.getResponseVerbosity,
          getCommunicationStyle: opts?.getCommunicationStyle,
        })
      : []),

    // Worktree isolation: EnterWorktree, ExitWorktree
    ...createWorktreeTools({ sessionId }),

    // Plan 模式: EnterPlanMode, ExitPlanMode
    enterPlanModeTool,
    exitPlanModeTool,

    // System: AskUserQuestion, Skill, SlashCommand, ToolSearch
    askUserQuestionTool,
    createSkillTool(skillRegistry),
    createSlashCommandTool(commandRegistry),
    toolSearchTool,
    ...(opts?.userPromptArtifactStore
      ? [createReadPromptArtifactTool(opts.userPromptArtifactStore)]
      : []),

    // Memory: MemoryRead, MemoryWrite
    memoryReadTool,
    memoryWriteTool,

    // Config: ConfigTool
    configTool,

    // LSP: semantic code intelligence (only when this Session owns servers)
    ...(opts?.lspManager?.available ? [createLspTool(opts.lspManager)] : []),
  ] as Tool[];

  return builtinTools;
}
