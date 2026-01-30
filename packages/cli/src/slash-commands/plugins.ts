/**
 * /plugins 斜杠命令
 *
 * 管理 Blade Code 插件系统
 */

import {
  clearAllPluginResources,
  getPluginInstaller,
  getPluginRegistry,
  integrateAllPlugins,
} from '../plugins/index.js';
import { sessionActions } from '../store/vanilla.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

const pluginsCommand: SlashCommand = {
  name: 'plugins',
  description: '管理已安装的插件',
  fullDescription: `管理 Blade Code 插件系统。

子命令：
  /plugins          - 打开插件管理界面
  /plugins list     - 列出所有已加载的插件
  /plugins info <name> - 显示插件详细信息
  /plugins install <url> - 从 Git URL 安装插件
  /plugins uninstall <name> - 卸载插件
  /plugins update <name> - 更新插件
  /plugins enable <name> - 启用插件
  /plugins disable <name> - 禁用插件
  /plugins refresh  - 刷新插件列表
  /plugins stats    - 显示插件统计信息`,
  usage:
    '/plugins [list|info|install|uninstall|update|enable|disable|refresh|stats] [name/url]',
  category: 'system',
  examples: [
    '/plugins',
    '/plugins list',
    '/plugins info my-plugin',
    '/plugins install user/repo',
    '/plugins install https://github.com/user/repo',
    '/plugins uninstall my-plugin',
    '/plugins update my-plugin',
    '/plugins enable my-plugin',
    '/plugins disable my-plugin',
    '/plugins refresh',
    '/plugins stats',
  ],

  handler: async (args, _context): Promise<SlashCommandResult> => {
    const subcommand = args[0]?.toLowerCase() || '';
    const registry = getPluginRegistry();

    switch (subcommand) {
      case '':
        // 刷新插件列表并显示插件管理界面
        await refreshPluginsInternal(registry);
        return {
          success: true,
          message: 'show_plugins_manager',
          data: { action: 'show_plugins_manager' },
        };

      case 'list':
      case 'ls':
        return listPlugins(registry);

      case 'info':
        return showPluginInfo(registry, args[1]);

      case 'install':
      case 'add':
        return installPlugin(args[1]);

      case 'uninstall':
      case 'remove':
      case 'rm':
        return uninstallPlugin(args[1]);

      case 'update':
      case 'upgrade':
        return updatePlugin(args[1]);

      case 'enable':
        return enablePlugin(registry, args[1]);

      case 'disable':
        return disablePlugin(registry, args[1]);

      case 'refresh':
        return refreshPlugins(registry);

      case 'stats':
        return showStats(registry);

      default:
        sessionActions().addAssistantMessage(
          `未知子命令: ${subcommand}\n使用 /plugins 查看帮助`
        );
        return { success: false, error: `Unknown subcommand: ${subcommand}` };
    }
  },
};

/**
 * 列出所有插件
 */
function listPlugins(
  registry: ReturnType<typeof getPluginRegistry>
): SlashCommandResult {
  const plugins = registry.getAll();

  if (plugins.length === 0) {
    sessionActions().addAssistantMessage(
      '没有已加载的插件。\n\n' +
        '使用 `--plugin-dir <path>` 参数加载插件，或将插件放置在：\n' +
        '- `~/.blade/plugins/` - 用户级插件\n' +
        '- `.blade/plugins/` - 项目级插件'
    );
    return { success: true, message: 'No plugins loaded' };
  }

  const lines: string[] = ['## 已加载的插件', ''];

  const bySource = registry.getBySource();

  if (bySource.cli.length > 0) {
    lines.push('### CLI 指定');
    for (const p of bySource.cli) {
      const status = p.status === 'inactive' ? ' ⏸️' : ' ✅';
      lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
      lines.push(`  ${p.manifest.description}`);
    }
    lines.push('');
  }

  if (bySource.project.length > 0) {
    lines.push('### 项目级');
    for (const p of bySource.project) {
      const status = p.status === 'inactive' ? ' ⏸️' : ' ✅';
      lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
      lines.push(`  ${p.manifest.description}`);
    }
    lines.push('');
  }

  if (bySource.user.length > 0) {
    lines.push('### 用户级');
    for (const p of bySource.user) {
      const status = p.status === 'inactive' ? ' ⏸️' : ' ✅';
      lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
      lines.push(`  ${p.manifest.description}`);
    }
  }

  sessionActions().addAssistantMessage(lines.join('\n'));
  return { success: true, message: 'Plugins listed' };
}

/**
 * 显示插件详细信息
 */
function showPluginInfo(
  registry: ReturnType<typeof getPluginRegistry>,
  name: string | undefined
): SlashCommandResult {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins info <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  const plugin = registry.get(name);
  if (!plugin) {
    sessionActions().addAssistantMessage(`未找到插件: ${name}`);
    return { success: false, error: `Plugin not found: ${name}` };
  }

  const lines: string[] = [
    `## ${plugin.manifest.name}`,
    '',
    `**版本**: ${plugin.manifest.version}`,
    `**描述**: ${plugin.manifest.description}`,
    `**状态**: ${plugin.status === 'active' ? '✅ 启用' : '⏸️ 禁用'}`,
    `**来源**: ${getSourceLabel(plugin.source)}`,
    `**路径**: \`${plugin.basePath}\``,
    '',
  ];

  if (plugin.manifest.author) {
    lines.push(`**作者**: ${plugin.manifest.author.name}`);
  }

  if (plugin.manifest.license) {
    lines.push(`**许可证**: ${plugin.manifest.license}`);
  }

  if (plugin.manifest.repository) {
    lines.push(`**仓库**: ${plugin.manifest.repository}`);
  }

  if (plugin.commands.length > 0) {
    lines.push('');
    lines.push(`### 命令 (${plugin.commands.length})`);
    for (const cmd of plugin.commands) {
      const hint = cmd.config.argumentHint ? ` ${cmd.config.argumentHint}` : '';
      const desc = cmd.config.description ? ` - ${cmd.config.description}` : '';
      lines.push(`- \`/${cmd.namespacedName}${hint}\`${desc}`);
    }
  }

  if (plugin.skills.length > 0) {
    lines.push('');
    lines.push(`### 技能 (${plugin.skills.length})`);
    for (const skill of plugin.skills) {
      lines.push(`- \`${skill.namespacedName}\` - ${skill.metadata.description}`);
    }
  }

  if (plugin.agents.length > 0) {
    lines.push('');
    lines.push(`### 代理 (${plugin.agents.length})`);
    for (const agent of plugin.agents) {
      lines.push(`- \`${agent.namespacedName}\` - ${agent.config.description}`);
    }
  }

  if (plugin.mcpServers) {
    const serverCount = Object.keys(plugin.mcpServers).length;
    lines.push('');
    lines.push(`### MCP 服务器 (${serverCount})`);
    for (const name of Object.keys(plugin.mcpServers)) {
      lines.push(`- \`${name}\``);
    }
  }

  if (plugin.hooks) {
    lines.push('');
    lines.push('### Hooks');
    lines.push('插件已配置 hooks');
  }

  sessionActions().addAssistantMessage(lines.join('\n'));
  return { success: true, message: 'Plugin info displayed' };
}

/**
 * 启用插件
 */
function enablePlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  name: string | undefined
): SlashCommandResult {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins enable <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  if (registry.enable(name)) {
    sessionActions().addAssistantMessage(`✅ 已启用插件: ${name}`);
    return { success: true, message: `Plugin ${name} enabled` };
  }

  const plugin = registry.get(name);
  if (!plugin) {
    sessionActions().addAssistantMessage(`未找到插件: ${name}`);
    return { success: false, error: `Plugin not found: ${name}` };
  }

  sessionActions().addAssistantMessage(`插件 ${name} 已经是启用状态`);
  return { success: true, message: `Plugin ${name} already enabled` };
}

/**
 * 禁用插件
 */
function disablePlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  name: string | undefined
): SlashCommandResult {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins disable <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  if (registry.disable(name)) {
    sessionActions().addAssistantMessage(`⏸️ 已禁用插件: ${name}`);
    return { success: true, message: `Plugin ${name} disabled` };
  }

  const plugin = registry.get(name);
  if (!plugin) {
    sessionActions().addAssistantMessage(`未找到插件: ${name}`);
    return { success: false, error: `Plugin not found: ${name}` };
  }

  sessionActions().addAssistantMessage(`插件 ${name} 已经是禁用状态`);
  return { success: true, message: `Plugin ${name} already disabled` };
}

/**
 * 内部刷新函数（不显示消息）
 * 用于 /plugins 在显示 UI 前自动刷新
 */
async function refreshPluginsInternal(
  registry: ReturnType<typeof getPluginRegistry>
): Promise<void> {
  // 1. 清除所有已注册的插件资源（命令、技能、代理）
  clearAllPluginResources();

  // 2. 重新扫描并加载插件
  await registry.refresh();

  // 3. 重新集成所有活跃插件的资源
  await integrateAllPlugins();
}

/**
 * 刷新插件列表（带消息输出）
 */
async function refreshPlugins(
  registry: ReturnType<typeof getPluginRegistry>
): Promise<SlashCommandResult> {
  try {
    // 1. 清除所有已注册的插件资源
    clearAllPluginResources();

    // 2. 重新扫描并加载插件
    const result = await registry.refresh();

    // 3. 重新集成所有活跃插件
    const integration = await integrateAllPlugins();

    const lines: string[] = [
      `✅ 已刷新插件列表`,
      '',
      `- 加载了 ${result.plugins.length} 个插件`,
      `- 集成了 ${integration.totalCommands} 个命令, ${integration.totalSkills} 个技能, ${integration.totalAgents} 个代理`,
    ];

    if (result.errors.length > 0) {
      lines.push(`- ${result.errors.length} 个加载错误`);
      lines.push('');
      lines.push('### 错误');
      for (const err of result.errors) {
        lines.push(`- \`${err.path}\`: ${err.error}`);
      }
    }

    if (integration.errors.length > 0) {
      lines.push('');
      lines.push('### 集成错误');
      for (const err of integration.errors) {
        lines.push(`- ${err}`);
      }
    }

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: 'Plugins refreshed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(`❌ 刷新失败: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * 显示插件统计信息
 */
function showStats(registry: ReturnType<typeof getPluginRegistry>): SlashCommandResult {
  const stats = registry.getStats();

  const lines: string[] = [
    '## 插件统计',
    '',
    `| 指标 | 数量 |`,
    `|------|------|`,
    `| 总插件数 | ${stats.total} |`,
    `| 启用 | ${stats.active} |`,
    `| 禁用 | ${stats.inactive} |`,
    `| 命令 | ${stats.commands} |`,
    `| 技能 | ${stats.skills} |`,
    `| 代理 | ${stats.agents} |`,
  ];

  sessionActions().addAssistantMessage(lines.join('\n'));
  return { success: true, message: 'Stats displayed' };
}

/**
 * 获取来源标签
 */
function getSourceLabel(source: string): string {
  switch (source) {
    case 'cli':
      return 'CLI 参数';
    case 'project':
      return '项目级';
    case 'user':
      return '用户级';
    default:
      return source;
  }
}

/**
 * 安装插件
 */
async function installPlugin(source: string | undefined): Promise<SlashCommandResult> {
  if (!source) {
    sessionActions().addAssistantMessage(
      '请指定插件 URL: `/plugins install <url>`\n\n' +
        '支持的格式：\n' +
        '- GitHub 简写: `user/repo`\n' +
        '- 完整 URL: `https://github.com/user/repo`'
    );
    return { success: false, error: 'Plugin URL required' };
  }

  sessionActions().addAssistantMessage(`正在安装插件: ${source}...`);

  const installer = getPluginInstaller();
  const result = await installer.install(source);

  if (result.success) {
    const lines = [
      `✅ 插件安装成功!`,
      '',
      `**名称**: ${result.pluginName}`,
      `**路径**: \`${result.pluginPath}\``,
    ];

    if (result.manifest) {
      lines.push(`**版本**: ${result.manifest.version}`);
      lines.push(`**描述**: ${result.manifest.description}`);
    }

    lines.push('');
    lines.push('使用 `/plugins refresh` 加载新安装的插件。');

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: `Installed ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`❌ 安装失败: ${result.error}`);
  return { success: false, error: result.error };
}

/**
 * 卸载插件
 */
async function uninstallPlugin(name: string | undefined): Promise<SlashCommandResult> {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins uninstall <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  const installer = getPluginInstaller();
  const result = await installer.uninstall(name);

  if (result.success) {
    sessionActions().addAssistantMessage(
      `✅ 已卸载插件: ${result.pluginName}\n\n` +
        '使用 `/plugins refresh` 刷新插件列表。'
    );
    return { success: true, message: `Uninstalled ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`❌ 卸载失败: ${result.error}`);
  return { success: false, error: result.error };
}

/**
 * 更新插件
 */
async function updatePlugin(name: string | undefined): Promise<SlashCommandResult> {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins update <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  sessionActions().addAssistantMessage(`正在更新插件: ${name}...`);

  const installer = getPluginInstaller();
  const result = await installer.update(name);

  if (result.success) {
    const lines = [`✅ 插件更新成功!`, '', `**名称**: ${result.pluginName}`];

    if (result.manifest) {
      lines.push(`**版本**: ${result.manifest.version}`);
    }

    lines.push('');
    lines.push('使用 `/plugins refresh` 重新加载插件。');

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: `Updated ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`❌ 更新失败: ${result.error}`);
  return { success: false, error: result.error };
}

export default pluginsCommand;
