/**
 * Slash Commands 注册和处理中心
 */

import Fuse from 'fuse.js';
import { discoverSkills, getSkillRegistry } from '../skills/index.js';
import type { SkillMetadata } from '../skills/types.js';
import { builtinCommands } from './builtinCommands.js';
import {
  type CustomCommandDiscoveryResult,
  CustomCommandRegistry,
} from './custom/index.js';
import gitCommand from './git.js';
import hooksCommand from './hooks.js';
import ideCommand from './ide.js';
import initCommand from './init.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import modelCommand from './model.js';
import permissionsCommand from './permissions.js';
import skillsCommand from './skills.js';
import themeCommand from './theme.js';
import type {
  CommandSuggestion,
  SlashCommand,
  SlashCommandContext,
  SlashCommandRegistry,
  SlashCommandResult,
} from './types.js';

// 注册所有 slash commands
const slashCommands: SlashCommandRegistry = {
  ...builtinCommands,
  init: initCommand,
  theme: themeCommand,
  permissions: permissionsCommand,
  model: modelCommand,
  git: gitCommand,
  ide: ideCommand,
  skills: skillsCommand,
  hooks: hooksCommand,
  login: loginCommand,
  logout: logoutCommand,
};

/**
 * 检测输入是否为 slash command
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * 解析 slash command
 */
export function parseSlashCommand(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('不是有效的 slash command');
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0] || '';
  const args = parts.slice(1);

  return { command, args };
}

/**
 * 根据名称或别名查找命令
 */
function findCommand(name: string): SlashCommand | undefined {
  // 先按名称查找
  if (slashCommands[name]) {
    return slashCommands[name];
  }
  // 再按别名查找
  for (const cmd of Object.values(slashCommands)) {
    if (cmd.aliases?.includes(name)) {
      return cmd;
    }
  }
  return undefined;
}

/**
 * 为 User-invocable Skill 创建 SlashCommand
 *
 * 当 Skill 设置 `user-invocable: true` 时，自动生成对应的 slash command。
 * 用户输入 `/skill-name args` 等同于 AI 调用 Skill({skill: "skill-name", args: "args"})
 */
function createSkillSlashCommand(skill: SkillMetadata): SlashCommand {
  const usage = skill.argumentHint
    ? `/${skill.name} ${skill.argumentHint}`
    : `/${skill.name}`;

  return {
    name: skill.name,
    description: skill.description,
    fullDescription: `[Skill] ${skill.description}${skill.whenToUse ? `\n\n**When to use:** ${skill.whenToUse}` : ''}`,
    usage,
    category: 'skill',
    examples: [usage],

    handler: async (args, _context): Promise<SlashCommandResult> => {
      // 返回特殊的 action，让 UI 层调用 Skill 工具
      return {
        success: true,
        message: `Invoking skill: ${skill.name}`,
        data: {
          action: 'invoke_skill',
          skillName: skill.name,
          skillArgs: args.join(' '),
        },
      };
    },
  };
}

/**
 * 查找 User-invocable Skill
 * 注意：调用前需确保 registry 已初始化
 */
function findUserInvocableSkill(name: string): SkillMetadata | undefined {
  const registry = getSkillRegistry();
  const skills = registry.getUserInvocableSkills();
  return skills.find((s) => s.name === name);
}

/**
 * 确保 SkillRegistry 已初始化
 */
async function ensureSkillsInitialized(): Promise<void> {
  await discoverSkills();
}

/**
 * 初始化自定义命令系统
 *
 * @param workspaceRoot - 工作目录
 * @returns 命令发现结果
 */
export async function initializeCustomCommands(
  workspaceRoot: string
): Promise<CustomCommandDiscoveryResult> {
  const registry = CustomCommandRegistry.getInstance();
  return await registry.initialize(workspaceRoot);
}

/**
 * 获取自定义命令注册表
 */
export function getCustomCommandRegistry(): CustomCommandRegistry {
  return CustomCommandRegistry.getInstance();
}

/**
 * 执行 slash command
 */
export async function executeSlashCommand(
  input: string,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  try {
    const { command, args } = parseSlashCommand(input);

    // 1. 先查找内置命令（支持别名）
    const slashCommand = findCommand(command);
    if (slashCommand) {
      return await slashCommand.handler(args, context);
    }

    // 2. 查找自定义命令
    const customRegistry = CustomCommandRegistry.getInstance();
    if (customRegistry.hasCommand(command)) {
      const customCommand = customRegistry.getCommand(command);
      if (customCommand) {
        const workspaceRoot = context.workspaceRoot || process.cwd();

        // 执行命令内容处理（参数插值、Bash 嵌入、文件引用）
        const processedContent = await customRegistry.executeCommand(command, {
          args,
          workspaceRoot,
          signal: context.signal,
        });

        if (processedContent) {
          // 返回处理后的内容，让 UI 层发送给 AI
          return {
            success: true,
            message: `执行自定义命令: /${command}`,
            data: {
              action: 'invoke_custom_command',
              commandName: command,
              processedContent,
              config: customCommand.config,
            },
          };
        }
      }
    }

    // 3. 确保 SkillRegistry 已初始化，再查找 User-invocable Skill
    await ensureSkillsInitialized();
    const skill = findUserInvocableSkill(command);
    if (skill) {
      const skillCommand = createSkillSlashCommand(skill);
      return await skillCommand.handler(args, context);
    }

    // 4. 未找到命令
    return {
      success: false,
      error: `未知命令: /${command}\n使用 /help 查看可用命令`,
    };
  } catch (error) {
    return {
      success: false,
      error: `命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

/**
 * 获取所有注册的命令（包括自定义命令和 User-invocable Skills）
 */
export function getRegisteredCommands(): SlashCommand[] {
  const builtinCmds = Object.values(slashCommands);

  // 获取自定义命令并转换为 SlashCommand
  const customRegistry = CustomCommandRegistry.getInstance();
  const customCmds = customRegistry.getAllCommands().map((cmd) => ({
    name: cmd.name,
    description: cmd.config.description || cmd.content.slice(0, 50),
    usage: cmd.config.argumentHint
      ? `/${cmd.name} ${cmd.config.argumentHint}`
      : `/${cmd.name}`,
    category: 'custom',
    handler: async () => ({ success: true }),
  }));

  // 获取 User-invocable Skills 并转换为 SlashCommand
  const skillRegistry = getSkillRegistry();
  const skillCmds = skillRegistry.getUserInvocableSkills().map(createSkillSlashCommand);

  return [...builtinCmds, ...customCmds, ...skillCmds];
}

/**
 * 注册新的 slash command
 */
export function registerSlashCommand(command: SlashCommand): void {
  slashCommands[command.name] = command;
}

/**
 * 获取命令补全建议（简单前缀匹配）
 */
export function getCommandSuggestions(partialCommand: string): string[] {
  const prefix = partialCommand.startsWith('/')
    ? partialCommand.slice(1)
    : partialCommand;
  const suggestions = Object.keys(slashCommands)
    .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((name) => `/${name}`);

  return suggestions;
}

/**
 * 获取模糊匹配的命令建议（使用 fuse.js）
 */
export function getFuzzyCommandSuggestions(input: string): CommandSuggestion[] {
  // 移除前导斜杠，并 trim 掉空格（用户可能输入 "/init " 然后按 Tab）
  const query = (input.startsWith('/') ? input.slice(1) : input).trim();

  // 准备搜索数据：将命令转换为可搜索的对象
  const builtinSearchable = Object.values(slashCommands).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases || [],
    label: undefined as string | undefined,
    argumentHint: undefined as string | undefined,
    isCustom: false,
    isSkill: false,
  }));

  // 添加自定义命令
  const customRegistry = CustomCommandRegistry.getInstance();
  const customSearchable = customRegistry.getAllCommands().map((cmd) => ({
    name: cmd.name,
    description: cmd.config.description || cmd.content.slice(0, 50),
    aliases: [] as string[],
    label: customRegistry.getCommandLabel(cmd),
    argumentHint: cmd.config.argumentHint,
    isCustom: true,
    isSkill: false,
  }));

  // 添加 User-invocable Skills
  const skillRegistry = getSkillRegistry();
  const skillSearchable = skillRegistry.getUserInvocableSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    aliases: [] as string[],
    label: '(skill)' as string | undefined,
    argumentHint: skill.argumentHint,
    isCustom: false,
    isSkill: true,
  }));

  const searchableCommands = [
    ...builtinSearchable,
    ...customSearchable,
    ...skillSearchable,
  ];

  if (!query) {
    // 如果没有输入，返回所有命令
    return searchableCommands.map((item) => ({
      command: `/${item.name}`,
      description: item.label ? `${item.description} ${item.label}` : item.description,
      argumentHint: item.argumentHint,
      matchScore: 50,
    }));
  }

  // 配置 Fuse.js
  const fuse = new Fuse(searchableCommands, {
    keys: [
      { name: 'name', weight: 3 }, // 命令名权重最高
      { name: 'aliases', weight: 2.5 }, // 别名权重次之
      { name: 'description', weight: 0.5 }, // 描述权重最低
    ],
    threshold: 0.4, // 匹配阈值（0 = 完全匹配，1 = 匹配任何东西）
    includeScore: true,
    ignoreLocation: true, // 忽略位置，只关注匹配度
    minMatchCharLength: 1,
  });

  // 执行搜索
  const results = fuse.search(query);

  // 转换为 CommandSuggestion 格式
  // Fuse.js 的 score 越低越好（0 = 完美匹配），我们需要反转为 0-100 的分数
  const suggestions: CommandSuggestion[] = results.map((result) => {
    const score = result.score ?? 1;
    const matchScore = Math.round((1 - score) * 100); // 转换为 0-100 分数
    const item = result.item;

    return {
      command: `/${item.name}`,
      description: item.label ? `${item.description} ${item.label}` : item.description,
      argumentHint: item.argumentHint,
      matchScore,
    };
  });

  // 过滤掉分数太低的结果（< 40 分）
  return suggestions.filter((s) => (s.matchScore || 0) >= 40);
}

export type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
