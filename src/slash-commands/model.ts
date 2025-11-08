/**
 * /model 命令 - 管理和切换模型配置
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const modelCommand: SlashCommand = {
  name: 'model',
  description: '管理和切换模型配置',
  usage: '/model [子命令] [参数]',
  fullDescription: `
管理和切换模型配置

子命令：
  (无参数)        显示模型选择器（交互式切换）
  list           列出所有模型配置（当前模型会高亮显示）
  add            添加新模型配置（交互式向导）
  remove <名称>  删除指定模型配置（按名称匹配）

示例：
  /model              # 显示模型选择器
  /model list         # 列出所有模型（● 标记当前模型）
  /model add          # 添加新模型
  /model remove 千问  # 删除名称包含"千问"的模型
  `,

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    if (!context.configManager) {
      return {
        success: false,
        error: '❌ ConfigManager 未初始化',
      };
    }

    const subcommand = args[0];

    // 无参数：显示模型选择器
    if (!subcommand) {
      const models = context.configManager.getAllModels();
      if (models.length === 0) {
        return {
          success: false,
          message: '❌ 没有可用的模型配置\n\n使用 /model add 添加模型',
        };
      }

      return {
        success: true,
        message: 'show_model_selector',
        data: { action: 'show_model_selector' },
      };
    }

    switch (subcommand) {
      case 'list': {
        const models = context.configManager.getAllModels();
        if (models.length === 0) {
          return {
            success: false,
            message: '❌ 没有可用的模型配置\n\n使用 /model add 添加模型',
          };
        }

        const currentId = context.configManager.getConfig().currentModelId;

        let output = '\n📋 可用模型配置：\n\n';
        for (const model of models) {
          const isCurrent = model.id === currentId;
          const marker = isCurrent ? '● ' : '○ ';
          output += `${marker}${model.name}\n`;
          output += `   Provider: ${model.provider}\n`;
          output += `   Model: ${model.model}\n`;
          output += `   Base URL: ${model.baseUrl}\n`;
          output += '\n';
        }

        return { success: true, message: output };
      }

      case 'add': {
        return {
          success: true,
          message: 'show_model_add_wizard',
          data: { action: 'show_model_add_wizard', mode: 'add' },
        };
      }

      case 'remove': {
        const nameQuery = args.slice(1).join(' ');
        if (!nameQuery) {
          return {
            success: false,
            message: '❌ 请指定要删除的模型名称\n用法: /model remove <名称>',
          };
        }

        const models = context.configManager.getAllModels();
        const matchedModel = models.find((m) =>
          m.name.toLowerCase().includes(nameQuery.toLowerCase())
        );

        if (!matchedModel) {
          return {
            success: false,
            message: `❌ 未找到匹配的模型配置: ${nameQuery}`,
          };
        }

        try {
          await context.configManager.removeModel(matchedModel.id);
          return {
            success: true,
            message: `✅ 已删除模型配置: ${matchedModel.name}`,
          };
        } catch (error) {
          return { success: false, message: `❌ ${(error as Error).message}` };
        }
      }

      default:
        return {
          success: false,
          message: `❌ 未知的子命令: ${subcommand}\n使用 /model 查看帮助`,
        };
    }
  },
};

export default modelCommand;
