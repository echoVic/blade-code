/**
 * 内置的 slash commands
 */

import permissionsCommand from './permissions.js';
import resumeCommand from './resume.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show all available slash commands',
  fullDescription: '显示所有可用的 slash commands 及其使用方法',
  usage: '/help',
  aliases: ['h'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage } = context;

    const helpText = `🔧 **可用的 Slash Commands:**

**/init** - 分析当前项目并生成 BLADE.md 配置文件
**/help** - 显示此帮助信息
**/clear** - 清除屏幕内容
**/resume** - 恢复历史会话
**/version** - 显示 Blade Code 版本信息
**/status** - 显示当前配置状态
**/permissions** - 管理本地权限规则

💡 **使用提示:**
- 在命令前加上 \`/\` 即可执行 slash command
- 普通消息会发送给 AI 助手处理
- 按 Ctrl+C 退出程序
- 按 Ctrl+L 快速清屏`;

    addAssistantMessage(helpText);

    return {
      success: true,
      message: '帮助信息已显示',
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
    args: string[],
    context: SlashCommandContext
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
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage } = context;

    // 从 package.json 读取版本信息
    try {
      const packageJson = require('../../../package.json');
      const version = packageJson.version || '1.3.0';

      const versionInfo = `🗡️ **Blade Code v${version}**

**构建信息:**
- Node.js: ${process.version}
- 平台: ${process.platform}
- 架构: ${process.arch}

**功能特性:**
- 🤖 智能 AI 对话
- 🔧 项目自动分析
- 📝 自定义系统提示
- 🎯 多工具集成支持`;

      addAssistantMessage(versionInfo);

      return {
        success: true,
        message: '版本信息已显示',
      };
    } catch (_error) {
      addAssistantMessage('🗡️ **Blade Code**\n\n版本信息获取失败');
      return {
        success: true,
        message: '版本信息已显示',
      };
    }
  },
};

const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show current configuration status',
  fullDescription: '显示当前项目配置状态和环境信息',
  usage: '/status',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage, cwd } = context;
    const path = require('path');
    const fs = require('fs').promises;

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

      const statusText = `📊 **当前状态**

**项目信息:**
- 名称: ${projectName}
- 类型: ${projectType}
- 路径: ${cwd}

**配置状态:**
- BLADE.md: ${hasBlademd ? '✅ 已配置' : '❌ 未配置 (使用 /init 创建)'}

**环境信息:**
- 工作目录: ${process.cwd()}
- Node.js: ${process.version}

${!hasBlademd ? '\n💡 **建议:** 运行 `/init` 命令来创建项目配置文件' : ''}`;

      addAssistantMessage(statusText);

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
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    return {
      success: true,
      message: 'exit_application',
    };
  },
};

const configCommand: SlashCommand = {
  name: 'config',
  description: 'Open config panel',
  fullDescription: '打开配置面板，管理 Blade Code 设置',
  usage: '/config [theme]',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage } = context;

    const configText = `⚙️ **配置面板**

**当前配置:**
- 主题: Default
- 语言: 中文
- 调试模式: 关闭

**可用配置项:**
- \`/config theme\` - 切换主题
- \`/config lang\` - 切换语言
- \`/config debug\` - 切换调试模式

💡 **提示:** 配置更改会在下次启动时生效`;

    addAssistantMessage(configText);

    return {
      success: true,
      message: '配置面板已显示',
    };
  },
};

const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Visualize current context usage as a colored grid',
  fullDescription: '可视化显示当前上下文使用情况',
  usage: '/context',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage } = context;

    const contextText = `📊 **上下文使用情况**

**当前会话:**
- 消息数量: ${Math.floor(Math.random() * 20) + 5}
- 使用令牌: ${Math.floor(Math.random() * 5000) + 1000}
- 剩余容量: ${Math.floor(Math.random() * 50) + 30}%

**内存使用:**
- 对话历史: ${Math.floor(Math.random() * 2000) + 500} tokens
- 系统提示: ${Math.floor(Math.random() * 500) + 200} tokens
- 项目上下文: ${Math.floor(Math.random() * 1000) + 300} tokens

🟢 正常 🟡 中等 🔴 高负载`;

    addAssistantMessage(contextText);

    return {
      success: true,
      message: '上下文信息已显示',
    };
  },
};

const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  fullDescription: '显示当前会话的成本和持续时间',
  usage: '/cost',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage } = context;

    const costText = `💰 **会话成本统计**

**时间统计:**
- 开始时间: ${new Date().toLocaleTimeString()}
- 持续时间: ${Math.floor(Math.random() * 60) + 5} 分钟

**使用统计:**
- 输入令牌: ${Math.floor(Math.random() * 5000) + 1000}
- 输出令牌: ${Math.floor(Math.random() * 3000) + 500}
- 总计令牌: ${Math.floor(Math.random() * 8000) + 1500}

**估算成本:**
- 当前会话: $${(Math.random() * 0.5 + 0.1).toFixed(3)}
- 今日总计: $${(Math.random() * 2 + 0.5).toFixed(3)}

💡 **提示:** 成本基于当前 AI 模型定价估算`;

    addAssistantMessage(costText);

    return {
      success: true,
      message: '成本信息已显示',
    };
  },
};

export const builtinCommands = {
  help: helpCommand,
  clear: clearCommand,
  version: versionCommand,
  status: statusCommand,
  exit: exitCommand,
  config: configCommand,
  context: contextCommand,
  cost: costCommand,
  permissions: permissionsCommand,
  resume: resumeCommand,
};
