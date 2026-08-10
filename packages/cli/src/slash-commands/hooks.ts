/**
 * /hooks 命令 - 管理 Hook 配置
 */

import { HookManager } from '../hooks/HookManager.js';
import { HookEvent } from '../hooks/types/HookTypes.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandResult,
  type SlashCommandUI,
} from './types.js';

const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'Manage hook configurations for tool events',
  fullDescription: `管理 Hook 配置，查看当前启用的 hooks 和执行统计。

子命令：
  /hooks          - 打开交互式 hooks 管理界面（添加新 hook）
  /hooks add      - 打开交互式 hooks 管理界面（添加新 hook）
  /hooks status   - 显示 hooks 启用状态和统计
  /hooks enable   - 启用当前会话的 hooks
  /hooks disable  - 禁用当前会话的 hooks
  /hooks trust    - 信任当前项目的当前 Hook 配置摘要
  /hooks revoke   - 撤销当前项目 Hook 信任
  /hooks list     - 列出所有配置的 hooks`,
  usage: '/hooks [add|status|enable|disable|trust|revoke|list]',
  category: 'system',
  examples: [
    '/hooks',
    '/hooks add',
    '/hooks status',
    '/hooks enable',
    '/hooks disable',
    '/hooks trust',
    '/hooks revoke',
    '/hooks list',
  ],

  handler: async (args, context): Promise<SlashCommandResult> => {
    const subcommand = args[0]?.toLowerCase() || '';
    const hookManager = HookManager.getInstance();
    const ui = getUI(context);
    const projectDir = context.workspaceRoot ?? context.cwd;

    switch (subcommand) {
      case '':
      case 'add': {
        // 返回特殊 action，让 UI 层显示 HooksManager 组件
        return {
          success: true,
          message: 'show_hooks_manager',
          data: { action: 'show_hooks_manager' },
        };
      }

      case 'status': {
        return showHooksStatus(hookManager, projectDir, context.sessionId, ui);
      }

      case 'enable': {
        if (!context.sessionId) {
          const error = '当前表面没有可用的 Session，无法切换 Hooks';
          ui.sendMessage(error);
          return { success: false, error };
        }
        hookManager.enableSession(context.sessionId, projectDir);
        ui.sendMessage('[OK] Hooks 已启用（当前会话）');
        return { success: true, message: 'Hooks enabled' };
      }

      case 'disable': {
        if (!context.sessionId) {
          const error = '当前表面没有可用的 Session，无法切换 Hooks';
          ui.sendMessage(error);
          return { success: false, error };
        }
        hookManager.disableSession(context.sessionId, projectDir);
        ui.sendMessage('Hooks 已禁用（当前会话）');
        return { success: true, message: 'Hooks disabled' };
      }

      case 'trust': {
        const status = await hookManager.trustProject(projectDir);
        ui.sendMessage(
          `[OK] 已信任当前 Hook 配置\n\n摘要：\`${status.currentDigest}\``
        );
        return { success: true, message: 'Hook configuration trusted' };
      }

      case 'revoke': {
        await hookManager.revokeProjectTrust(projectDir);
        ui.sendMessage('已撤销当前项目的 Hook 信任；配置型 Hooks 不再执行。');
        return { success: true, message: 'Hook trust revoked' };
      }

      case 'list': {
        return listHooksConfig(hookManager, projectDir, ui);
      }

      default: {
        ui.sendMessage(`未知子命令: ${subcommand}\n使用 /hooks 查看帮助`);
        return { success: false, error: `Unknown subcommand: ${subcommand}` };
      }
    }
  },
};

/**
 * 显示 hooks 状态
 */
async function showHooksStatus(
  hookManager: HookManager,
  projectDir: string,
  sessionId: string | undefined,
  ui: SlashCommandUI
): Promise<SlashCommandResult> {
  const isEnabled = hookManager.isEnabled(projectDir, sessionId);
  const config = hookManager.getConfig(projectDir);
  const trust = await hookManager.getTrustStatus(projectDir);

  // 统计各类型配置的 hooks 数量
  const hookCounts: Record<string, number> = {};
  for (const event of Object.values(HookEvent)) {
    const matchers = config[event];
    if (matchers && Array.isArray(matchers)) {
      const totalHooks = matchers.reduce((sum, m) => sum + (m.hooks?.length || 0), 0);
      if (totalHooks > 0) {
        hookCounts[event] = totalHooks;
      }
    }
  }

  const lines: string[] = [
    '## Hooks 状态',
    '',
    `**状态**: ${isEnabled ? '[OK] 启用' : '禁用'}`,
    `**信任**: ${trust.state}`,
    `**配置摘要**: ${trust.currentDigest ? `\`${trust.currentDigest}\`` : '无'}`,
    '',
  ];

  if (Object.keys(hookCounts).length > 0) {
    lines.push('**已配置的 Hooks**:');
    lines.push('');
    for (const [event, count] of Object.entries(hookCounts)) {
      lines.push(`- ${event}: ${count} 个 hook`);
    }
  } else {
    lines.push('*没有配置任何 hooks*');
  }

  lines.push('');
  lines.push('---');
  lines.push('使用 `/hooks list` 查看详细配置');
  lines.push('使用 `/hooks enable` 或 `/hooks disable` 切换状态');

  ui.sendMessage(lines.join('\n'));
  return { success: true, message: 'Hooks status displayed' };
}

/**
 * 列出详细的 hooks 配置
 */
async function listHooksConfig(
  hookManager: HookManager,
  projectDir: string,
  ui: SlashCommandUI
): Promise<SlashCommandResult> {
  const config = hookManager.getConfig(projectDir);
  const trust = await hookManager.getTrustStatus(projectDir);
  const lines: string[] = ['## Hooks 配置详情', '', `信任状态：**${trust.state}**`, ''];

  let hasAnyHooks = false;

  for (const event of Object.values(HookEvent)) {
    const matchers = config[event];
    if (!matchers || !Array.isArray(matchers) || matchers.length === 0) {
      continue;
    }

    hasAnyHooks = true;
    lines.push(`### ${event}`);
    lines.push('');

    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      const matcherName = matcher.name || `Matcher ${i + 1}`;

      // 显示 matcher 配置
      const matcherConfig = matcher.matcher;
      let matcherDesc = '所有';
      if (matcherConfig) {
        const parts: string[] = [];
        if (matcherConfig.tools) {
          const tools = Array.isArray(matcherConfig.tools)
            ? matcherConfig.tools.join(', ')
            : matcherConfig.tools;
          parts.push(`工具: ${tools}`);
        }
        if (matcherConfig.paths) {
          const paths = Array.isArray(matcherConfig.paths)
            ? matcherConfig.paths.join(', ')
            : matcherConfig.paths;
          parts.push(`路径: ${paths}`);
        }
        if (matcherConfig.commands) {
          const commands = Array.isArray(matcherConfig.commands)
            ? matcherConfig.commands.join(', ')
            : matcherConfig.commands;
          parts.push(`命令: ${commands}`);
        }
        if (parts.length > 0) {
          matcherDesc = parts.join('; ');
        }
      }

      lines.push(`**${matcherName}** (匹配: ${matcherDesc})`);

      // 显示 hooks
      for (const hook of matcher.hooks || []) {
        if (hook.type === 'command') {
          lines.push(`  - \`${hook.command}\``);
        } else if (hook.type === 'prompt') {
          const promptPreview =
            hook.prompt.slice(0, 50) + (hook.prompt.length > 50 ? '...' : '');
          lines.push(`  - [prompt] ${promptPreview}`);
        }
      }
      lines.push('');
    }
  }

  if (!hasAnyHooks) {
    lines.push('*没有配置任何 hooks*');
    lines.push('');
    lines.push(
      '在 `.blade/settings.local.json` 或 `~/.blade/settings.json` 中配置 hooks。'
    );
  }

  ui.sendMessage(lines.join('\n'));
  return { success: true, message: 'Hooks config listed' };
}

export default hooksCommand;
