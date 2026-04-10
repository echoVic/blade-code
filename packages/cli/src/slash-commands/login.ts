/**
 * /login 命令
 *
 * 登录 OAuth 服务以使用 AI 模型。
 * 支持：
 * - Google Antigravity (默认)
 * - GitHub Copilot
 */

import { AntigravityAuth } from '../services/antigravity/AntigravityAuth.js';
import {
  ANTIGRAVITY_MODELS,
  GEMINI_CLI_MODELS,
  type OAuthConfigType,
} from '../services/antigravity/types.js';
import { CopilotAuth } from '../services/copilot/CopilotAuth.js';
import { COPILOT_MODELS } from '../services/copilot/types.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

/**
 * 登录服务类型
 */
type LoginService = 'antigravity' | 'gemini-cli' | 'copilot';

/**
 * 解析登录参数
 */
function parseLoginArgs(args: string[]): LoginService {
  if (args.includes('copilot') || args.includes('github')) {
    return 'copilot';
  }
  if (args.includes('gemini') || args.includes('gemini-cli')) {
    return 'gemini-cli';
  }
  return 'antigravity';
}

export const loginCommand: SlashCommand = {
  name: 'login',
  description: '登录 OAuth 服务（Antigravity / Copilot）',
  fullDescription: `登录 OAuth 服务以使用 AI 模型。

**支持的服务：**

1. **Google Antigravity**（默认）
   - 通过 Google OAuth 认证
   - 支持 Claude、Gemini、GPT-OSS 模型
   - 需要 Gemini Code Assist 订阅

2. **GitHub Copilot**
   - 通过 GitHub Device Flow OAuth 认证
   - 支持 GPT-4o、Claude 3.5 Sonnet、Gemini 等模型
   - 需要 GitHub Copilot 订阅

**用法：**
- \`/login\` - 登录 Antigravity（默认）
- \`/login gemini\` - 使用 Gemini CLI OAuth（Antigravity 备选）
- \`/login copilot\` - 登录 GitHub Copilot

登录后，使用 \`/model add\` 添加模型配置。`,
  usage: '/login [copilot|gemini]',
  category: 'auth',
  examples: ['/login', '/login copilot', '/login gemini'],

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const service = parseLoginArgs(args);

    // ================================
    // GitHub Copilot 登录
    // ================================
    if (service === 'copilot') {
      const auth = CopilotAuth.getInstance();

      try {
        // 检查是否已登录
        const isLoggedIn = await auth.isLoggedIn();
        if (isLoggedIn) {
          const status = await auth.getStatus();
          const expiresIn = status.expiresAt
            ? Math.round((status.expiresAt.getTime() - Date.now()) / 1000 / 60)
            : 0;

          ui.sendMessage('[OK] 已登录 GitHub Copilot');
          ui.sendMessage(`Token 有效期还剩约 ${expiresIn} 分钟`);
          ui.sendMessage('');
          ui.sendMessage('如需重新登录，请先执行 /logout copilot');

          return {
            success: true,
            message: '已登录',
            content: `已登录 GitHub Copilot，Token 有效期还剩约 ${expiresIn} 分钟`,
          };
        }

        // 执行登录
        await auth.login();

        ui.sendMessage('');
        ui.sendMessage('**可用模型：**');

        for (const model of Object.values(COPILOT_MODELS)) {
          ui.sendMessage(`  - ${model.id} (${model.provider})`);
        }

        ui.sendMessage('');
        ui.sendMessage('**下一步：**');
        ui.sendMessage('使用 `/model add` 添加 Copilot 模型配置');
        ui.sendMessage('Provider 选择 `copilot`，Model 输入模型 ID（如 gpt-4o）');

        return {
          success: true,
          message: '登录成功',
          content: '已成功登录 GitHub Copilot。使用 /model add 添加模型配置。',
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        ui.sendMessage(`登录失败: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }

    // ================================
    // Google Antigravity 登录
    // ================================
    const auth = AntigravityAuth.getInstance();
    const configType: OAuthConfigType =
      service === 'gemini-cli' ? 'gemini-cli' : 'antigravity';
    const configName = service === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity';

    try {
      // 检查是否已登录
      const isLoggedIn = await auth.isLoggedIn();
      if (isLoggedIn) {
        const status = await auth.getStatus();
        const expiresIn = status.expiresAt
          ? Math.round((status.expiresAt.getTime() - Date.now()) / 1000 / 60)
          : 0;
        const currentConfig =
          status.configType === 'gemini-cli' ? 'Gemini CLI' : 'Antigravity';

        ui.sendMessage(`[OK] 已登录（${currentConfig} OAuth）`);
        ui.sendMessage(`Token 有效期还剩约 ${expiresIn} 分钟`);
        ui.sendMessage('');
        ui.sendMessage('如需重新登录或切换 OAuth 方式，请先执行 /logout');

        return {
          success: true,
          message: '已登录',
          content: `已登录（${currentConfig} OAuth），Token 有效期还剩约 ${expiresIn} 分钟`,
        };
      }

      // 执行登录
      ui.sendMessage(`开始 ${configName} OAuth 登录...`);
      ui.sendMessage('');

      await auth.login(configType);

      ui.sendMessage('');
      ui.sendMessage(`[OK] ${configName} 登录成功！`);
      ui.sendMessage('');
      ui.sendMessage('**可用模型：**');

      // 根据 OAuth 类型显示不同的模型列表
      const models = service === 'gemini-cli' ? GEMINI_CLI_MODELS : ANTIGRAVITY_MODELS;
      for (const model of Object.values(models)) {
        const thinkingBadge = model.supportsThinking ? ' (Thinking)' : '';
        ui.sendMessage(`  - ${model.id}${thinkingBadge}`);
      }

      ui.sendMessage('');
      ui.sendMessage('**下一步：**');
      ui.sendMessage(`使用 \`/model add\` 添加 ${configName} 模型配置`);

      return {
        success: true,
        message: '登录成功',
        content: `已成功通过 ${configName} OAuth 登录。使用 /model add 添加模型配置。`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      ui.sendMessage(`登录失败: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
};
