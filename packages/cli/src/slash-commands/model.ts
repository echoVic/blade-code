/**
 * /model 命令 - 管理和切换模型配置
 */

import { probeModelProvider } from '../services/ProviderHealthService.js';
import { getModelDisplayName } from '../services/pi/resolveModelConfig.js';
import { configActions, getAllModels, getConfig } from '../store/vanilla.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const modelCommand: SlashCommand = {
  name: 'model',
  description: '管理和切换模型配置',
  usage: '/model [子命令] [参数]',
  fullDescription: `
管理和切换模型配置

子命令：
  (无参数)        显示模型选择器（交互式切换）
  add            添加新模型配置（交互式向导）
  remove <名称>  删除指定模型配置（按名称匹配）
  provider list  列出自定义 Provider 渠道
  provider test <ID>  发送最小真实请求检查渠道
  provider set <ID> <Base URL>  更新渠道 endpoint
  provider remove <ID> [--with-models]  删除渠道
  once <模型> <内容>  仅当前轮对话使用指定模型

示例：
  /model              # 显示模型选择器
  /model add          # 添加新模型
  /model remove 千问  # 删除名称包含"千问"的模型
  /model once claude-sonnet 帮我总结这段代码
  `,

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const subcommand = args[0];

    // 无参数：显示模型选择器
    if (!subcommand) {
      const models = getAllModels();
      if (models.length === 0) {
        return {
          success: false,
          message: '没有可用的模型配置\n\n使用 /model add 添加模型',
        };
      }

      return {
        success: true,
        message: 'show_model_selector',
        data: { action: 'show_model_selector' },
      };
    }

    switch (subcommand) {
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
            message: '请指定要删除的模型名称\n用法: /model remove <名称>',
          };
        }

        const models = getAllModels();
        const matchedModel = models.find((m) =>
          getModelDisplayName(m).toLowerCase().includes(nameQuery.toLowerCase())
        );

        if (!matchedModel) {
          return {
            success: false,
            message: `未找到匹配的模型配置: ${nameQuery}`,
          };
        }

        try {
          await configActions().removeModel(matchedModel.id);
          return {
            success: true,
            message: `[OK] 已删除模型配置: ${getModelDisplayName(matchedModel)}`,
          };
        } catch (error) {
          return { success: false, message: `${(error as Error).message}` };
        }
      }
      case 'once': {
        const modelQuery = args[1];
        const prompt = args.slice(2).join(' ').trim();
        if (!modelQuery || !prompt) {
          return {
            success: false,
            message: '用法: /model once <模型> <内容>',
          };
        }
        const models = getAllModels();
        const matched =
          models.find((m) => m.id === modelQuery) ||
          models.find((m) =>
            getModelDisplayName(m).toLowerCase().includes(modelQuery.toLowerCase())
          );
        if (!matched) {
          return {
            success: false,
            message: `未找到匹配的模型配置: ${modelQuery}`,
          };
        }
        return {
          success: true,
          data: {
            action: 'invoke_once_model',
            modelId: matched.id,
            prompt,
          },
        };
      }
      case 'provider': {
        const action = args[1];
        const providerId = args[2];
        const config = getConfig();
        if (!config) {
          return { success: false, message: '配置尚未初始化' };
        }
        if (!action || action === 'list') {
          const providers = Object.entries(config.modelProviders);
          if (providers.length === 0) {
            return {
              success: true,
              message: '没有配置自定义 Provider 渠道',
            };
          }
          return {
            success: true,
            message: providers
              .map(
                ([id, provider]) =>
                  `${id} · ${provider.name} · ${provider.wireApi} · ${provider.baseUrl}`
              )
              .join('\n'),
          };
        }
        if (!providerId || !config.modelProviders[providerId]) {
          return {
            success: false,
            message: `未找到 Provider 渠道: ${providerId ?? ''}`,
          };
        }

        if (action === 'test') {
          const model = config.models.find(
            (candidate) => candidate.provider === providerId
          );
          if (!model) {
            return {
              success: false,
              message: `Provider 渠道没有可探测模型: ${providerId}`,
            };
          }
          const probe = await probeModelProvider(model, config, {
            timeoutMs: 10_000,
          });
          return {
            success: probe.ok,
            message: probe.ok
              ? `[OK] ${providerId} · ${probe.latencyMs}ms · ${probe.wireApi}`
              : `[FAIL] ${providerId} · ${probe.message} [${probe.code}]`,
          };
        }

        if (action === 'set') {
          const baseUrl = args[3];
          if (!baseUrl) {
            return {
              success: false,
              message: '用法: /model provider set <ID> <Base URL>',
            };
          }
          const existing = config.modelProviders[providerId];
          try {
            await configActions().updateModelProvider(providerId, {
              ...existing,
              baseUrl,
            });
            return {
              success: true,
              message: `[OK] 已更新 Provider endpoint: ${providerId}`,
            };
          } catch (error) {
            return {
              success: false,
              message: error instanceof Error ? error.message : '更新失败',
            };
          }
        }

        if (action === 'remove') {
          const removeModels = args.includes('--with-models');
          try {
            const result = await configActions().removeModelProvider(providerId, {
              removeModels,
            });
            return {
              success: true,
              message:
                `[OK] 已删除 Provider 渠道: ${providerId}` +
                (result.removedModelIds.length > 0
                  ? `；同时删除 ${result.removedModelIds.length} 个模型配置`
                  : ''),
            };
          } catch (error) {
            return {
              success: false,
              message: error instanceof Error ? error.message : '删除失败',
            };
          }
        }

        return {
          success: false,
          message: '用法: /model provider <list|test|set|remove> [ID] [参数]',
        };
      }

      default:
        return {
          success: false,
          message: `未知的子命令: ${subcommand}\n使用 /model 查看可用操作`,
        };
    }
  },
};

export default modelCommand;
