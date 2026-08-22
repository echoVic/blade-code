/**
 * 内置的 slash commands
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  derivePromptCacheMetrics,
  formatPromptCacheBreak,
  formatPromptCacheHitRate,
} from '../api/promptCacheMetrics.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { probeModelProvider } from '../services/ProviderHealthService.js';
import {
  getModelDisplayName,
  resolveModelConfig,
} from '../services/pi/resolveModelConfig.js';
import { getConfig, getCurrentModel, getState } from '../store/vanilla.js';
import { getCwd } from '../utils/cwd.js';
import { getVersion } from '../utils/packageInfo.js';
import { agentsCommand } from './agents.js';
import { archiveCommand, unarchiveCommand } from './archive.js';
import branchCommand from './branch.js';
import compactCommand from './compact.js';
import { CustomCommandRegistry } from './custom/index.js';
import effortCommand from './effort.js';
import exportCommand from './export.js';
import forkCommand from './fork.js';
import mcpCommand from './mcp.js';
import memoryCommand from './memory.js';
import permissionsCommand from './permissions.js';
import resumeCommand from './resume.js';
import rewindCommand from './rewind.js';
import speedCommand from './speed.js';
import styleCommand from './style.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';
import verbosityCommand from './verbosity.js';

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show all available slash commands',
  fullDescription: '显示所有可用的 slash commands 及其使用方法',
  usage: '/help',
  aliases: ['h'],
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);

    let helpText = `**可用的 Slash Commands:**

**/init** - 分析当前项目并生成 BLADE.md 配置文件
**/git** - Git 仓库查询和 AI 辅助 (status/log/diff/review/commit)
**/agents** - 管理 subagent 配置（创建、编辑、删除）
**/mcp** - 显示 MCP 服务器状态和可用工具
**/help** - 显示此帮助信息
**/btw <question>** - 在不改变主对话的情况下询问一个旁路问题
**/clear** - 清除屏幕内容
**/resume** - 恢复历史会话
**/branch** - 从当前会话创建独立分支
**/fork [sessionId]** - 从历史会话创建独立分支
**/archive [sessionId]** - 归档当前或指定的已停止会话树
**/unarchive <sessionId>** - 恢复归档会话树
**/export [path] [--reasoning]** - 导出当前 durable 会话为安全 Markdown
**/effort [level]** - 查看或设置当前 Session 的推理强度
**/speed [tier]** - 查看或设置当前 Session 的 provider 服务等级（别名 /fast）
**/verbosity [level]** - 查看或设置当前 Session 的响应详略（别名 /detail）
**/style [name]** - 查看或设置当前 Session 的沟通风格（别名 /personality）
**/compact** - 手动压缩上下文，生成总结并节省 token
**/cost** - 显示当前会话 token 消耗和费用估算
**/doctor** - 诊断 API 连通性和配置健康状况
**/memory** - 管理项目 Auto Memory（list/show/edit/clear）
**/version** - 显示 Blade Code 版本信息
**/status** - 显示当前配置状态
**/permissions** - 管理本地权限规则`;

    // 添加自定义命令列表
    const workspaceRoot = context.workspaceRoot || context.cwd || getCwd();
    const customRegistry = CustomCommandRegistry.getExistingInstance(workspaceRoot);
    if (customRegistry?.isInitialized()) {
      const customCommands = customRegistry.getAllCommands();
      if (customCommands.length > 0) {
        helpText += `\n\n**自定义命令:**\n`;

        // 按来源分组
        const { project, user } = customRegistry.getCommandsBySource();

        if (project.length > 0) {
          helpText += `\n**项目命令** (.blade/commands/):\n`;
          for (const cmd of project) {
            const hint = cmd.config.argumentHint ? ` ${cmd.config.argumentHint}` : '';
            const desc = cmd.config.description || '(无描述)';
            const ns = cmd.namespace ? ` (${cmd.namespace})` : '';
            helpText += `**/${cmd.name}**${hint} - ${desc}${ns}\n`;
          }
        }

        if (user.length > 0) {
          helpText += `\n**用户命令** (~/.blade/commands/):\n`;
          for (const cmd of user) {
            const hint = cmd.config.argumentHint ? ` ${cmd.config.argumentHint}` : '';
            const desc = cmd.config.description || '(无描述)';
            const ns = cmd.namespace ? ` (${cmd.namespace})` : '';
            helpText += `**/${cmd.name}**${hint} - ${desc}${ns}\n`;
          }
        }
      }
    }

    helpText += `

**使用提示:**
- 在命令前加上 \`/\` 即可执行 slash command
- 普通消息会发送给 AI 助手处理
- 按 Ctrl+C 退出程序
- 按 Ctrl+L 快速清屏`;

    ui.sendMessage(helpText);

    return {
      success: true,
      message: '帮助信息已显示',
      content: helpText,
    };
  },
};

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear conversation history and free up context',
  fullDescription: '清除屏幕内容和对话历史',
  usage: '/clear',
  aliases: ['cls'],
  async handler(
    _args: string[],
    _context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    // 这个命令会在 useCommandHandler 中特殊处理
    return {
      success: true,
      message: 'clear_screen',
    };
  },
};

const versionCommand: SlashCommand = {
  name: 'version',
  description: 'Show Blade Code version information',
  fullDescription: '显示 Blade Code 版本信息和构建详情',
  usage: '/version',
  aliases: ['v'],
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const version = getVersion();

    const versionInfo = `**Blade Code v${version}**

**构建信息:**
- Node.js: ${process.version}
- 平台: ${process.platform}
- 架构: ${process.arch}

**功能特性:**
- 智能 AI 对话
- 项目自动分析
- 自定义系统提示
- 多工具集成支持`;

    ui.sendMessage(versionInfo);

    return {
      success: true,
      message: '版本信息已显示',
    };
  },
};

const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show current configuration status',
  fullDescription: '显示当前项目配置状态和环境信息',
  usage: '/status',
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const { cwd } = context;

    try {
      // 检查配置文件状态
      const blademdPath = path.join(cwd, 'BLADE.md');
      const hasBlademd = await fs
        .access(blademdPath)
        .then(() => true)
        .catch(() => false);

      // 检查项目信息
      const packageJsonPath = path.join(cwd, 'package.json');
      let projectName = '未知项目';
      let projectType = '未知类型';

      try {
        const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageContent);
        projectName = packageJson.name || '未知项目';

        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps.react) projectType = 'React 项目';
        else if (deps.vue) projectType = 'Vue 项目';
        else if (deps.next) projectType = 'Next.js 项目';
        else if (deps.express) projectType = 'Express 项目';
        else projectType = 'Node.js 项目';
      } catch {
        // 无法读取 package.json
      }

      const config = getConfig();
      const currentModel = getCurrentModel();
      const state = getState();
      const usage = state.session.tokenUsage;

      const statusText = `**当前状态**

**项目信息:**
- 名称: ${projectName}
- 类型: ${projectType}
- 路径: ${cwd}

**模型配置:**
- 当前模型: ${currentModel ? getModelDisplayName(currentModel) : 'N/A'} (${currentModel?.model ?? 'N/A'})
- Provider: ${currentModel?.provider ?? 'N/A'}
- 可用模型数: ${config?.models?.length ?? 0}

**会话统计:**
- Turn: ${usage.turnCount}
- Token: ${usage.totalInputTokens.toLocaleString()} in / ${usage.totalOutputTokens.toLocaleString()} out
- 费用: ${usage.estimatedCostUsd > 0 ? `$${usage.estimatedCostUsd.toFixed(4)}` : 'N/A'}
- Context: ${usage.maxContextTokens > 0 ? `${Math.round((1 - usage.inputTokens / usage.maxContextTokens) * 100)}% 剩余` : 'N/A'}

**配置状态:**
- BLADE.md: ${hasBlademd ? '[OK] 已配置' : '[FAIL] 未配置 (使用 /init 创建)'}

**环境信息:**
- 工作目录: ${getCwd()} (process.cwd: ${process.cwd()})
- Node.js: ${process.version}

${!hasBlademd ? '\n**建议:** 运行 `/init` 命令来创建项目配置文件' : ''}`;

      ui.sendMessage(statusText);

      return {
        success: true,
        message: '状态信息已显示',
      };
    } catch (error) {
      return {
        success: false,
        error: `获取状态信息失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  },
};

const exitCommand: SlashCommand = {
  name: 'exit',
  description: 'Exit the REPL',
  fullDescription: '退出 Blade Code 命令行界面',
  usage: '/exit',
  aliases: ['quit', 'q'],
  async handler(
    _args: string[],
    _context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    return {
      success: true,
      message: 'exit_application',
    };
  },
};

const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Visualize current context usage as a colored grid',
  fullDescription: '可视化显示当前上下文使用情况',
  usage: '/context',
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);

    // 获取真实数据
    const config = getConfig();
    const currentModel = getCurrentModel();
    const sessionState = getState().session;
    const sessionMessages = sessionState.messages || [];

    // 计算 token 数量
    const messages = sessionMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const modelName = currentModel?.model || 'gpt-4';
    const totalTokens =
      messages.length > 0 ? TokenCounter.countTokens(messages, modelName) : 0;
    const maxTokens =
      currentModel && config
        ? resolveModelConfig(currentModel, config, 'off').model.contextWindow
        : 128000;
    const usagePercent =
      maxTokens > 0 ? ((totalTokens / maxTokens) * 100).toFixed(1) : '0';
    const remainingPercent = (100 - parseFloat(usagePercent)).toFixed(1);

    // 确定状态指示器
    const usageNum = parseFloat(usagePercent);
    let statusIndicator: string;
    if (usageNum < 50) {
      statusIndicator = '[OK] 正常';
    } else if (usageNum < 80) {
      statusIndicator = '[WARN] 中等';
    } else {
      statusIndicator = '[CRITICAL] 高负载';
    }

    const contextText = `**上下文使用情况**

**当前会话:**
- 消息数量: ${sessionMessages.length}
- Token 使用: ${totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()}
- 使用率: ${usagePercent}%
- 剩余容量: ${remainingPercent}%

**模型信息:**
- 模型: ${currentModel?.model || '未配置'}
- 上下文窗口: ${maxTokens.toLocaleString()} tokens

**状态:** ${statusIndicator}

使用 \`/compact\` 可手动压缩上下文`;

    ui.sendMessage(contextText);

    return {
      success: true,
      message: '上下文信息已显示',
    };
  },
};

const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show session token usage and estimated cost',
  fullDescription: '显示当前会话的 token 消耗和费用估算',
  usage: '/cost',
  aliases: [],
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const state = getState();
    const usage = state.session.tokenUsage;
    const model = getCurrentModel();

    const costStr =
      usage.estimatedCostUsd > 0
        ? `$${usage.estimatedCostUsd < 0.01 ? usage.estimatedCostUsd.toFixed(6) : usage.estimatedCostUsd.toFixed(4)}`
        : 'N/A (unknown model pricing)';

    const promptCache = derivePromptCacheMetrics(usage);
    const cacheInfo =
      promptCache.hitRate !== undefined
        ? `\n- Cache hit rate: ${formatPromptCacheHitRate(promptCache.hitRate)}\n- Cache read: ${promptCache.cacheReadTokens.toLocaleString()} tokens\n- Cache write: ${promptCache.cacheWriteTokens.toLocaleString()} tokens${usage.cacheBreak ? `\n- Last cache break: ${formatPromptCacheBreak(usage.cacheBreak)}` : ''}`
        : '';

    const info = `**Session Cost Summary**

- Model: ${model?.model ?? 'unknown'}
- Turns: ${usage.turnCount}
- Current input: ${usage.inputTokens.toLocaleString()} tokens
- Current output: ${usage.outputTokens.toLocaleString()} tokens
- **Total input: ${usage.totalInputTokens.toLocaleString()} tokens**
- **Total output: ${usage.totalOutputTokens.toLocaleString()} tokens**${cacheInfo}
- Context remaining: ${usage.maxContextTokens > 0 ? Math.round((1 - usage.inputTokens / usage.maxContextTokens) * 100) : '?'}%
- **Estimated cost: ${costStr}**`;

    ui.sendMessage(info);

    return { success: true, message: 'Cost summary displayed' };
  },
};

const doctorCommand: SlashCommand = {
  name: 'doctor',
  description: 'Diagnose API connectivity and configuration health',
  fullDescription: '诊断 API 连通性和配置健康状况',
  usage: '/doctor',
  aliases: [],
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const config = getConfig();
    const models = config?.models ?? [];

    if (models.length === 0) {
      ui.sendMessage(
        '❌ 没有配置任何模型。请先运行 `/init` 或编辑 `~/.blade/config.json`'
      );
      return { success: false, message: 'No models configured' };
    }

    const results: string[] = ['**API Connectivity Diagnosis**\n'];
    let healthy = true;

    for (const model of models) {
      const probe = await probeModelProvider(model, config!, {
        timeoutMs: 10_000,
      });
      healthy &&= probe.ok;
      if (probe.ok) {
        results.push(
          `✅ **${getModelDisplayName(model)}** (${model.provider}/${model.model}) — ${probe.latencyMs}ms · ${probe.wireApi}`
        );
      } else {
        results.push(
          `❌ **${getModelDisplayName(model)}** (${model.provider}/${model.model}) — ${probe.latencyMs}ms — ${probe.message} [${probe.code}]`
        );
      }
    }

    ui.sendMessage(results.join('\n'));
    return {
      success: healthy,
      message: healthy
        ? 'Doctor diagnosis complete'
        : 'Doctor found unhealthy model providers',
      content: results.join('\n'),
    };
  },
};

export const builtinCommands = {
  help: helpCommand,
  archive: archiveCommand,
  unarchive: unarchiveCommand,
  export: exportCommand,
  effort: effortCommand,
  speed: speedCommand,
  verbosity: verbosityCommand,
  style: styleCommand,
  branch: branchCommand,
  clear: clearCommand,
  version: versionCommand,
  status: statusCommand,
  exit: exitCommand,
  context: contextCommand,
  cost: costCommand,
  doctor: doctorCommand,
  permissions: permissionsCommand,
  resume: resumeCommand,
  fork: forkCommand,
  rewind: rewindCommand,
  compact: compactCommand,
  mcp: mcpCommand,
  memory: memoryCommand,
  agents: agentsCommand,
};
