import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { SubagentConfig, SubagentFrontmatter } from './types.js';

/**
 * Subagent 注册表
 *
 * 职责：
 * - 注册和发现 subagents
 * - 解析 Markdown + YAML frontmatter 配置
 * - 生成 LLM 可读的描述
 */
export class SubagentRegistry {
	private subagents = new Map<string, SubagentConfig>();

	/**
	 * 注册一个 subagent
	 * @param config - 子代理配置
	 */
	register(config: SubagentConfig): void {
		if (this.subagents.has(config.name)) {
			throw new Error(`Subagent '${config.name}' already registered`);
		}
		this.subagents.set(config.name, config);
	}

	/**
	 * 获取指定 subagent
	 */
	getSubagent(name: string): SubagentConfig | undefined {
		return this.subagents.get(name);
	}

	/**
	 * 获取所有 subagent 名称
	 */
	getAllNames(): string[] {
		return Array.from(this.subagents.keys());
	}

	/**
	 * 获取所有 subagent 配置
	 */
	getAllSubagents(): SubagentConfig[] {
		return Array.from(this.subagents.values());
	}

	/**
	 * 生成 LLM 可读的 subagent 描述（用于系统提示）
	 */
	getDescriptionsForPrompt(): string {
		const subagents = this.getAllSubagents();
		if (subagents.length === 0) {
			return 'No subagents available.';
		}

		const descriptions = subagents.map((config) => {
			let desc = `- ${config.name}: ${config.description}`;

			// 添加工具列表
			if (config.tools && config.tools.length > 0) {
				desc += ` (Tools: ${config.tools.join(', ')})`;
			}

			return desc;
		});

		return `Available subagent types and the tools they have access to:\n${descriptions.join('\n')}`;
	}

	/**
	 * 从目录加载所有 subagent 配置文件
	 * @param dirPath - 配置文件目录
	 */
	loadFromDirectory(dirPath: string): void {
		if (!fs.existsSync(dirPath)) {
			return;
		}

		const files = fs.readdirSync(dirPath);
		for (const file of files) {
			if (!file.endsWith('.md')) continue;

			const filePath = path.join(dirPath, file);
			try {
				const config = this.parseConfigFile(filePath);
				this.register(config);
			} catch (error) {
				console.warn(`Failed to load subagent config from ${filePath}:`, error);
			}
		}
	}

	/**
	 * 解析 Markdown + YAML frontmatter 配置文件
	 */
	private parseConfigFile(filePath: string): SubagentConfig {
		const content = fs.readFileSync(filePath, 'utf-8');

		// 解析 YAML frontmatter
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!frontmatterMatch) {
			throw new Error(`No YAML frontmatter found in ${filePath}`);
		}

		const [, frontmatterYaml, markdownContent] = frontmatterMatch;
		const frontmatter = yaml.parse(frontmatterYaml) as SubagentFrontmatter;

		// 验证必需字段
		if (!frontmatter.name || !frontmatter.description) {
			throw new Error(`Missing required fields (name, description) in ${filePath}`);
		}

		// 使用 Markdown 内容作为系统提示
		const systemPrompt = markdownContent.trim();

		return {
			name: frontmatter.name,
			description: frontmatter.description,
			systemPrompt,
			tools: frontmatter.tools,
			configPath: filePath,
		};
	}

	/**
	 * 从标准位置加载所有 subagent 配置
	 *
	 * 按优先级加载：
	 * 1. 用户级配置（~/.blade/agents/）
	 * 2. 项目级配置（.blade/agents/）
	 *
	 * @returns 加载的 subagent 数量
	 */
	loadFromStandardLocations(): number {
		const os = require('node:os');
		const path = require('node:path');

		// 1. 加载用户级配置
		const userAgentsDir = path.join(os.homedir(), '.blade', 'agents');
		this.loadFromDirectory(userAgentsDir);

		// 2. 加载项目级配置
		const projectAgentsDir = path.join(process.cwd(), '.blade', 'agents');
		this.loadFromDirectory(projectAgentsDir);

		return this.getAllNames().length;
	}

	/**
	 * 清空所有注册的 subagents（用于测试）
	 */
	clear(): void {
		this.subagents.clear();
	}
}

/**
 * 全局单例
 */
export const subagentRegistry = new SubagentRegistry();
