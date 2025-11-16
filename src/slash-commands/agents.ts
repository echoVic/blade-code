/**
 * /agents slash command - 管理 subagent 配置
 */

import os from 'node:os';
import path from 'node:path';
import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

export const agentsCommand: SlashCommand = {
	name: 'agents',
	description: 'Manage agent configurations',
	fullDescription:
		'Create, edit, or delete custom subagents. Subagents are specialized agents that Claude can delegate tasks to.',
	usage: '/agents [list|create|help]',
	category: 'System',
	examples: ['/agents', '/agents list', '/agents help'],

	async handler(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
		const subcommand = args[0];

		// 无参数 - 显示 agents 管理对话框
		if (!subcommand) {
			return {
				success: true,
				message: 'show_agents_manager',
				data: { action: 'show_agents_manager' },
			};
		}

		// list 子命令 - 显示文本列表
		if (subcommand === 'list') {
			const { addAssistantMessage } = context;
			const allAgents = subagentRegistry.getAllNames()
				.map((name) => subagentRegistry.getSubagent(name))
				.filter((agent): agent is NonNullable<typeof agent> => agent !== undefined);

			if (allAgents.length === 0) {
				const message =
					'📋 **Agents 管理**\n\n' +
					'❌ 没有找到任何 agent 配置\n\n' +
					'**配置文件位置:**\n' +
					'- 项目级: `.blade/agents/`\n' +
					'- 用户级: `~/.blade/agents/`\n\n' +
					'💡 使用 `/agents` 打开管理对话框';

				addAssistantMessage(message);
				return { success: true, message: 'No agents found' };
			}

			// 按位置分组
			const projectPath = path.join(process.cwd(), '.blade', 'agents');
			const userPath = path.join(os.homedir(), '.blade', 'agents');

			const projectAgents = allAgents.filter((a) =>
				a.configPath?.startsWith(projectPath),
			);
			const userAgents = allAgents.filter((a) => a.configPath?.startsWith(userPath));

			let message = `📋 **Agents 管理**\n\n找到 **${allAgents.length}** 个 agent:\n\n`;

			// 项目级 agents
			if (projectAgents.length > 0) {
				message += `**项目级** (.blade/agents/):\n`;
				for (const agent of projectAgents) {
					message += `\n• **${agent.name}**\n`;
					message += `  ${agent.description}\n`;
					if (agent.tools && agent.tools.length > 0) {
						message += `  工具: ${agent.tools.join(', ')}\n`;
					}
					if (agent.color) {
						message += `  颜色: ${agent.color}\n`;
					}
				}
				message += '\n';
			}

			// 用户级 agents
			if (userAgents.length > 0) {
				message += `**用户级** (~/.blade/agents/):\n`;
				for (const agent of userAgents) {
					message += `\n• **${agent.name}**\n`;
					message += `  ${agent.description}\n`;
					if (agent.tools && agent.tools.length > 0) {
						message += `  工具: ${agent.tools.join(', ')}\n`;
					}
					if (agent.color) {
						message += `  颜色: ${agent.color}\n`;
					}
				}
				message += '\n';
			}

			message += '\n💡 使用 `/agents` 打开管理对话框';

			addAssistantMessage(message);
			return { success: true, message: `Listed ${allAgents.length} agents` };
		}

		// Help 子命令
		if (subcommand === 'help') {
			const { addAssistantMessage } = context;
			const message =
				'📋 **Agents 管理帮助**\n\n' +
				'**可用子命令:**\n' +
				'- `/agents list` - 列出所有已配置的 agents\n' +
				'- `/agents help` - 显示此帮助信息\n\n' +
				'**手动创建 Agent:**\n\n' +
				'1. 在项目目录或用户目录创建 `.blade/agents/` 文件夹\n' +
				'2. 创建 Markdown 文件 (如 `my-agent.md`)\n' +
				'3. 使用 YAML frontmatter 定义配置:\n\n' +
				'```markdown\n' +
				'---\n' +
				'name: my-agent\n' +
				'description: 这个 agent 的用途和使用场景\n' +
				'tools:\n' +
				'  - Glob\n' +
				'  - Grep\n' +
				'  - Read\n' +
				'color: blue  # 可选: red/blue/green/yellow/purple/orange/pink/cyan\n' +
				'---\n\n' +
				'# 系统提示词\n\n' +
				'你是一个专门的代理...\n' +
				'```\n\n' +
				'**配置优先级:**\n' +
				'- 项目级 (`.blade/agents/`) - 最高优先级\n' +
				'- 用户级 (`~/.blade/agents/`) - 较低优先级\n\n' +
				'**可用工具:**\n' +
				'- `Glob` - 文件搜索\n' +
				'- `Grep` - 内容搜索\n' +
				'- `Read` - 读取文件\n' +
				'- `Write` - 写入文件\n' +
				'- `Edit` - 编辑文件\n' +
				'- `Bash` - 执行命令\n' +
				'- 省略 `tools` 字段 = 继承所有工具\n\n' +
				'💡 **提示:** 创建文件后,重启 Blade 使配置生效';

			addAssistantMessage(message);
			return { success: true, message: 'Help displayed' };
		}

		// create 子命令 - 显示创建对话框
		if (subcommand === 'create') {
			return {
				success: true,
				message: 'show_agent_creation_wizard',
				data: { action: 'show_agent_creation_wizard' },
			};
		}

		// 未知子命令
		const { addAssistantMessage } = context;
		const message =
			`❌ 未知子命令: \`${subcommand}\`\n\n` +
			'使用 `/agents help` 查看可用命令';

		addAssistantMessage(message);
		return { success: false, error: `Unknown subcommand: ${subcommand}` };
	},
};
