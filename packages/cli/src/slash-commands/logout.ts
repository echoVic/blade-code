/**
 * /logout 命令
 *
 * 登出 OAuth 服务，清除本地存储的 token。
 * 支持：
 * - Google Antigravity (默认)
 * - GitHub Copilot
 */

import { AntigravityAuth } from '../services/antigravity/AntigravityAuth.js';
import { CopilotAuth } from '../services/copilot/CopilotAuth.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
import { getUI } from './types.js';

/**
 * 登出服务类型
 */
type LogoutService = 'antigravity' | 'copilot' | 'all';

/**
 * 解析登出参数
 */
function parseLogoutArgs(args: string[]): LogoutService {
  if (args.includes('copilot') || args.includes('github')) {
    return 'copilot';
  }
  if (args.includes('all')) {
    return 'all';
  }
  return 'antigravity';
}

export const logoutCommand: SlashCommand = {
  name: 'logout',
  description: '登出 OAuth 服务并清除 token',
  fullDescription: `登出 OAuth 服务，清除本地存储的 token。

**用法：**
- \`/logout\` - 登出 Antigravity（默认）
- \`/logout copilot\` - 登出 GitHub Copilot
- \`/logout all\` - 登出所有服务

登出后，使用对应服务的模型将需要重新登录。`,
  usage: '/logout [copilot|all]',
  category: 'auth',
  examples: ['/logout', '/logout copilot', '/logout all'],

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);
    const service = parseLogoutArgs(args);

    // ================================
    // 登出所有服务
    // ================================
    if (service === 'all') {
      const results: string[] = [];

      // 登出 Antigravity
      try {
        const antigravityAuth = AntigravityAuth.getInstance();
        if (await antigravityAuth.isLoggedIn()) {
          await antigravityAuth.logout();
          results.push('Antigravity');
        }
      } catch {
        // 忽略错误
      }

      // 登出 Copilot
      try {
        const copilotAuth = CopilotAuth.getInstance();
        if (await copilotAuth.isLoggedIn()) {
          await copilotAuth.logout();
          results.push('GitHub Copilot');
        }
      } catch {
        // 忽略错误
      }

      if (results.length > 0) {
        ui.sendMessage(`✅ 已登出: ${results.join(', ')}`);
      } else {
        ui.sendMessage('ℹ️ 当前未登录任何服务');
      }

      return {
        success: true,
        message: '登出完成',
        content:
          results.length > 0 ? `已登出: ${results.join(', ')}` : '当前未登录任何服务',
      };
    }

    // ================================
    // 登出 GitHub Copilot
    // ================================
    if (service === 'copilot') {
      const auth = CopilotAuth.getInstance();

      try {
        const isLoggedIn = await auth.isLoggedIn();
        if (!isLoggedIn) {
          ui.sendMessage('ℹ️ 当前未登录 GitHub Copilot');
          return {
            success: true,
            message: '未登录',
            content: '当前未登录 GitHub Copilot',
          };
        }

        await auth.logout();

        ui.sendMessage('✅ 已登出 GitHub Copilot');
        ui.sendMessage('');
        ui.sendMessage('Token 已清除。如需重新使用，请执行 /login copilot');

        return {
          success: true,
          message: '登出成功',
          content: '已登出 GitHub Copilot，Token 已清除。',
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        ui.sendMessage(`❌ 登出失败: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }

    // ================================
    // 登出 Google Antigravity
    // ================================
    const auth = AntigravityAuth.getInstance();

    try {
      const isLoggedIn = await auth.isLoggedIn();
      if (!isLoggedIn) {
        ui.sendMessage('ℹ️ 当前未登录 Antigravity');

        return {
          success: true,
          message: '未登录',
          content: '当前未登录 Antigravity',
        };
      }

      await auth.logout();

      ui.sendMessage('✅ 已登出 Antigravity');
      ui.sendMessage('');
      ui.sendMessage('Token 已清除。如需重新使用 Antigravity，请执行 /login');

      return {
        success: true,
        message: '登出成功',
        content: '已登出 Antigravity，Token 已清除。',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      ui.sendMessage(`❌ 登出失败: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
};
