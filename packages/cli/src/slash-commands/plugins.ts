/**
 * /plugins 斜杠命令
 *
 * 管理 Blade Code 插件系统
 */

import { resolveWorkspaceAgentResources } from '../agent/resources/WorkspaceAgentResources.js';
import {
  addPluginMarketplace,
  getPluginInstaller,
  getPluginRegistry,
  installWorkspacePlugin,
  type PluginSettingsScope,
  refreshPluginMarketplace,
  refreshWorkspacePlugins,
  removePluginMarketplace,
  setWorkspacePluginEnabled,
  setWorkspacePluginSourcePolicy,
  uninstallWorkspacePlugin,
  updateWorkspacePlugin,
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
  /plugins install <source|name@marketplace> --trust - 安装受信任插件
  /plugins uninstall <name> --confirm - 卸载受管插件
  /plugins update <name> --trust - 原子更新插件
  /plugins marketplace <add|list|update|remove> - 管理 Marketplace
  /plugins policy [show|set] - 查看或收紧来源策略
  /plugins enable <name> [--scope local|project|global] - 启用插件
  /plugins disable <name> [--scope local|project|global] - 禁用插件
  /plugins refresh  - 刷新插件列表
  /plugins stats    - 显示插件统计信息`,
  usage:
    '/plugins [list|info|install|uninstall|update|enable|disable|refresh|stats] [name/url]',
  category: 'system',
  examples: [
    '/plugins',
    '/plugins list',
    '/plugins info my-plugin',
    '/plugins install user/repo --trust',
    '/plugins install my-plugin@team-market --trust',
    '/plugins uninstall my-plugin --confirm',
    '/plugins update my-plugin --trust',
    '/plugins marketplace add user/plugin-marketplace',
    '/plugins marketplace list',
    '/plugins policy show',
    '/plugins policy set --require-sha true --hosts github.com --scope global',
    '/plugins enable my-plugin',
    '/plugins disable my-plugin',
    '/plugins refresh',
    '/plugins stats',
  ],

  handler: async (args, context): Promise<SlashCommandResult> => {
    const subcommand = args[0]?.toLowerCase() || '';
    const workspaceRoot = context.workspaceRoot || context.cwd;
    const registry = (await resolveWorkspaceAgentResources(workspaceRoot)).plugins;

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
        return installPlugin(registry, args.slice(1));

      case 'uninstall':
      case 'remove':
      case 'rm':
        return uninstallPlugin(registry, args.slice(1));

      case 'update':
      case 'upgrade':
        return updatePlugin(registry, args.slice(1));

      case 'marketplace':
      case 'marketplaces':
        return manageMarketplace(registry, args.slice(1));

      case 'policy':
        return managePluginPolicy(registry, args.slice(1));

      case 'enable':
        return await enablePlugin(registry, args[1], parseScope(args.slice(2)));

      case 'disable':
        return await disablePlugin(registry, args[1], parseScope(args.slice(2)));

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

function parseScope(args: string[]): PluginSettingsScope {
  const scopeIndex = args.findIndex(
    (argument) => argument === '--scope' || argument.startsWith('--scope=')
  );
  const raw =
    scopeIndex >= 0
      ? args[scopeIndex]?.includes('=')
        ? args[scopeIndex]?.split('=', 2)[1]
        : args[scopeIndex + 1]
      : args[0];
  if (!raw) return 'local';
  if (raw === 'user') return 'global';
  if (raw === 'local' || raw === 'project' || raw === 'global') return raw;
  throw new Error(`Invalid plugin scope: ${raw}`);
}

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
      const status = p.status === 'inactive' ? ' [PAUSED]' : ' [OK]';
      lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
      lines.push(`  ${p.manifest.description}`);
    }
    lines.push('');
  }

  if (bySource.project.length > 0) {
    lines.push('### 项目级');
    for (const p of bySource.project) {
      const status = p.status === 'inactive' ? ' [PAUSED]' : ' [OK]';
      lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
      lines.push(`  ${p.manifest.description}`);
    }
    lines.push('');
  }

  if (bySource.user.length > 0) {
    lines.push('### 用户级');
    for (const p of bySource.user) {
      const status = p.status === 'inactive' ? ' [PAUSED]' : ' [OK]';
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
    `**状态**: ${plugin.status === 'active' ? '[OK] 启用' : '禁用'}`,
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
  if (plugin.compatibilityIssues?.length) {
    lines.push('');
    lines.push('### Compatibility');
    for (const issue of plugin.compatibilityIssues) {
      lines.push(`- ${issue.message}`);
    }
  }

  sessionActions().addAssistantMessage(lines.join('\n'));
  return { success: true, message: 'Plugin info displayed' };
}

/**
 * 启用插件
 */
async function enablePlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  name: string | undefined,
  scope: PluginSettingsScope
): Promise<SlashCommandResult> {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins enable <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  const plugin = registry.get(name);
  if (!plugin) {
    sessionActions().addAssistantMessage(`未找到插件: ${name}`);
    return { success: false, error: `Plugin not found: ${name}` };
  }

  try {
    const result = await setWorkspacePluginEnabled(
      registry.getWorkspaceRoot(),
      name,
      true,
      scope
    );
    const message = result.effectiveEnabled
      ? `[OK] 已启用插件: ${name} (${scope})`
      : `已写入 ${scope} 启用设置，但更具体的配置仍禁用 ${name}`;
    sessionActions().addAssistantMessage(message);
    return { success: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(message);
    return { success: false, error: message };
  }
}

/**
 * 禁用插件
 */
async function disablePlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  name: string | undefined,
  scope: PluginSettingsScope
): Promise<SlashCommandResult> {
  if (!name) {
    sessionActions().addAssistantMessage('请指定插件名称: `/plugins disable <name>`');
    return { success: false, error: 'Plugin name required' };
  }

  const plugin = registry.get(name);
  if (!plugin) {
    sessionActions().addAssistantMessage(`未找到插件: ${name}`);
    return { success: false, error: `Plugin not found: ${name}` };
  }

  try {
    const result = await setWorkspacePluginEnabled(
      registry.getWorkspaceRoot(),
      name,
      false,
      scope
    );
    const message = result.effectiveEnabled
      ? `已写入 ${scope} 禁用设置，但更具体的配置仍启用 ${name}`
      : `已禁用插件: ${name} (${scope})`;
    sessionActions().addAssistantMessage(message);
    return { success: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(message);
    return { success: false, error: message };
  }
}

/**
 * 内部刷新函数（不显示消息）
 * 用于 /plugins 在显示 UI 前自动刷新
 */
async function refreshPluginsInternal(
  registry: ReturnType<typeof getPluginRegistry>
): Promise<void> {
  await refreshWorkspacePlugins(registry.getWorkspaceRoot());
}

/**
 * 刷新插件列表（带消息输出）
 */
async function refreshPlugins(
  registry: ReturnType<typeof getPluginRegistry>
): Promise<SlashCommandResult> {
  try {
    const { registry: refreshed, discovery: result } = await refreshWorkspacePlugins(
      registry.getWorkspaceRoot()
    );
    const stats = refreshed.getStats();

    const lines: string[] = [
      `[OK] 已刷新插件列表`,
      '',
      `- 加载了 ${result.plugins.length} 个插件`,
      `- 集成了 ${stats.commands} 个命令, ${stats.skills} 个技能, ${stats.agents} 个代理`,
    ];

    if (result.errors.length > 0) {
      lines.push(`- ${result.errors.length} 个加载错误`);
      lines.push('');
      lines.push('### 错误');
      for (const err of result.errors) {
        lines.push(`- \`${err.path}\`: ${err.error}`);
      }
    }

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: 'Plugins refreshed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(`刷新失败: ${message}`);
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
function parsePackageArguments(args: string[]): {
  positional: string[];
  trust: boolean;
  confirm: boolean;
  ref?: string;
} {
  const positional: string[] = [];
  let trust = false;
  let confirm = false;
  let ref: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--trust') {
      trust = true;
    } else if (argument === '--confirm') {
      confirm = true;
    } else if (argument === '--ref') {
      ref = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--ref=')) {
      ref = argument.slice('--ref='.length);
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown plugin option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  return { positional, trust, confirm, ref };
}

async function installPlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  args: string[]
): Promise<SlashCommandResult> {
  const parsed = parsePackageArguments(args);
  const source = parsed.positional[0];
  if (!source) {
    sessionActions().addAssistantMessage(
      '请指定插件来源: `/plugins install <source> --trust`\n\n' +
        '支持的格式：\n' +
        '- Marketplace: `plugin@marketplace`\n' +
        '- GitHub 简写: `user/repo`\n' +
        '- 完整 URL: `https://github.com/user/repo`\n' +
        '- 本地目录: `./my-plugin`（需要 Workspace Trust）'
    );
    return { success: false, error: 'Plugin source required' };
  }
  if (!parsed.trust) {
    const message =
      '安装插件会激活其 Hooks、MCP、技能和命令。确认来源后使用 `--trust` 重试。';
    sessionActions().addAssistantMessage(message);
    return { success: false, error: 'Plugin source trust required' };
  }

  sessionActions().addAssistantMessage(`正在安装插件: ${source}...`);

  const { result } = await installWorkspacePlugin(registry.getWorkspaceRoot(), source, {
    trusted: parsed.trust,
    ref: parsed.ref,
  });

  if (result.success) {
    const lines = [
      `[OK] 插件安装成功!`,
      '',
      `**名称**: ${result.pluginName}`,
      `**提交**: \`${result.installation?.revision ?? 'local'}\``,
    ];

    if (result.manifest) {
      lines.push(`**版本**: ${result.manifest.version}`);
      lines.push(`**描述**: ${result.manifest.description}`);
    }
    if (result.installedDependencies?.length) {
      lines.push(`**依赖**: ${result.installedDependencies.join(', ')}`);
    }

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: `Installed ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`安装失败: ${result.error}`);
  return { success: false, error: result.error };
}

/**
 * 卸载插件
 */
async function uninstallPlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  args: string[]
): Promise<SlashCommandResult> {
  const parsed = parsePackageArguments(args);
  const name = parsed.positional[0];
  if (!name) {
    sessionActions().addAssistantMessage(
      '请指定插件名称: `/plugins uninstall <name> --confirm`'
    );
    return { success: false, error: 'Plugin name required' };
  }
  if (!parsed.confirm) {
    const message = `卸载 ${name} 需要显式确认，请添加 \`--confirm\``;
    sessionActions().addAssistantMessage(message);
    return { success: false, error: 'Plugin uninstall confirmation required' };
  }
  const { result } = await uninstallWorkspacePlugin(
    registry.getWorkspaceRoot(),
    name,
    parsed.confirm
  );

  if (result.success) {
    sessionActions().addAssistantMessage(`[OK] 已卸载插件: ${result.pluginName}`);
    return { success: true, message: `Uninstalled ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`卸载失败: ${result.error}`);
  return { success: false, error: result.error };
}

/**
 * 更新插件
 */
async function updatePlugin(
  registry: ReturnType<typeof getPluginRegistry>,
  args: string[]
): Promise<SlashCommandResult> {
  const parsed = parsePackageArguments(args);
  const name = parsed.positional[0];
  if (!name) {
    sessionActions().addAssistantMessage(
      '请指定插件名称: `/plugins update <name> --trust`'
    );
    return { success: false, error: 'Plugin name required' };
  }
  if (!parsed.trust) {
    const message = `更新会执行 ${name} 的新代码，确认来源后使用 \`--trust\` 重试`;
    sessionActions().addAssistantMessage(message);
    return { success: false, error: 'Plugin source trust required' };
  }

  sessionActions().addAssistantMessage(`正在更新插件: ${name}...`);

  const { result } = await updateWorkspacePlugin(registry.getWorkspaceRoot(), name, {
    trusted: parsed.trust,
  });

  if (result.success) {
    const lines = [
      result.changed ? `[OK] 插件更新成功!` : `[OK] 插件已是最新版本`,
      '',
      `**名称**: ${result.pluginName}`,
      `**提交**: \`${result.installation?.revision ?? 'local'}\``,
    ];

    if (result.manifest) {
      lines.push(`**版本**: ${result.manifest.version}`);
    }
    if (result.updatedDependencies?.length) {
      lines.push(`**依赖更新**: ${result.updatedDependencies.join(', ')}`);
    }

    sessionActions().addAssistantMessage(lines.join('\n'));
    return { success: true, message: `Updated ${result.pluginName}` };
  }

  sessionActions().addAssistantMessage(`更新失败: ${result.error}`);
  return { success: false, error: result.error };
}

function policyOption(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function policyBoolean(value: string | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === 'on' || value === '1') return true;
  if (value === 'false' || value === 'off' || value === '0') return false;
  throw new Error(`${label} must be true or false`);
}

function policyList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
}

function formatPluginPolicy(
  policy: ReturnType<ReturnType<typeof getPluginRegistry>['getSourcePolicy']>
): string {
  return [
    '## Plugin Source Policy',
    '',
    `- Restrict sources: ${policy.restrictToAllowedSources ? 'on' : 'off'}`,
    `- Require full Git SHA: ${policy.requireGitCommitSha ? 'on' : 'off'}`,
    `- Git hosts: ${policy.allowedGitHosts.join(', ') || '(none)'}`,
    `- Marketplaces: ${policy.allowedMarketplaces.join(', ') || '(none)'}`,
    `- Local roots: ${policy.allowedLocalRoots.join(', ') || '(none)'}`,
  ].join('\n');
}

async function managePluginPolicy(
  registry: ReturnType<typeof getPluginRegistry>,
  args: string[]
): Promise<SlashCommandResult> {
  const operation = args[0]?.toLowerCase() ?? 'show';
  if (operation === 'show' || operation === 'status') {
    const message = formatPluginPolicy(registry.getSourcePolicy());
    sessionActions().addAssistantMessage(message);
    return { success: true, message };
  }
  if (operation !== 'set') {
    const error =
      'Usage: /plugins policy set [--restrict true] [--require-sha true] ' +
      '[--hosts host,...] [--marketplaces name,...] [--local-roots /path,...] ' +
      '[--scope global|project|local]';
    sessionActions().addAssistantMessage(error);
    return { success: false, error };
  }

  try {
    const current = registry.getSourcePolicy();
    const restrict = policyBoolean(policyOption(args, '--restrict'), '--restrict');
    const requireSha = policyBoolean(
      policyOption(args, '--require-sha'),
      '--require-sha'
    );
    const hosts = policyList(policyOption(args, '--hosts'));
    const marketplaces = policyList(policyOption(args, '--marketplaces'));
    const localRoots = policyList(policyOption(args, '--local-roots'));
    if (
      restrict === undefined &&
      requireSha === undefined &&
      hosts === undefined &&
      marketplaces === undefined &&
      localRoots === undefined
    ) {
      throw new Error('No plugin policy fields were provided');
    }
    const rawScope = policyOption(args, '--scope') ?? 'global';
    const scope = parseScope([rawScope]);
    const policy = await setWorkspacePluginSourcePolicy(
      registry.getWorkspaceRoot(),
      {
        ...current,
        ...(restrict === undefined ? {} : { restrictToAllowedSources: restrict }),
        ...(requireSha === undefined ? {} : { requireGitCommitSha: requireSha }),
        ...(hosts === undefined ? {} : { allowedGitHosts: hosts }),
        ...(marketplaces === undefined ? {} : { allowedMarketplaces: marketplaces }),
        ...(localRoots === undefined ? {} : { allowedLocalRoots: localRoots }),
      },
      scope
    );
    const message = formatPluginPolicy(policy);
    sessionActions().addAssistantMessage(message);
    return { success: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(`Plugin policy update failed: ${message}`);
    return { success: false, error: message };
  }
}

async function manageMarketplace(
  registry: ReturnType<typeof getPluginRegistry>,
  args: string[]
): Promise<SlashCommandResult> {
  const operation = args[0]?.toLowerCase() ?? 'list';
  const parsed = parsePackageArguments(args.slice(1));
  try {
    if (operation === 'list' || operation === 'ls') {
      const marketplaces = await getPluginInstaller().listCatalogs();
      const lines =
        marketplaces.length === 0
          ? ['没有已配置的 Plugin Marketplace。']
          : [
              '## Plugin Marketplaces',
              '',
              ...marketplaces.flatMap(({ marketplace, manifest }) => [
                `- **${marketplace.name}** · ${manifest.plugins.length} plugins`,
                `  ${manifest.description ?? manifest.metadata?.description ?? ''}`,
                `  revision: \`${marketplace.revision}\``,
              ]),
            ];
      sessionActions().addAssistantMessage(lines.join('\n'));
      return { success: true, message: 'Marketplaces listed' };
    }

    if (operation === 'add') {
      const source = parsed.positional[0];
      if (!source) {
        throw new Error('Usage: /plugins marketplace add <source> [--ref <ref>]');
      }
      const result = await addPluginMarketplace(
        registry.getWorkspaceRoot(),
        source,
        parsed.ref
      );
      if (!result.success) throw new Error(result.error);
      const message = `[OK] 已添加 Marketplace ${result.marketplace?.name}（${result.manifest?.plugins.length ?? 0} 个插件）`;
      sessionActions().addAssistantMessage(message);
      return { success: true, message };
    }

    if (operation === 'update' || operation === 'refresh') {
      const requested = parsed.positional[0];
      const names = requested
        ? [requested]
        : (await getPluginInstaller().listMarketplaces()).map(
            (marketplace) => marketplace.name
          );
      if (names.length === 0) {
        const message = '没有可更新的 Marketplace';
        sessionActions().addAssistantMessage(message);
        return { success: true, message };
      }
      const updated: string[] = [];
      for (const name of names) {
        const result = await refreshPluginMarketplace(
          registry.getWorkspaceRoot(),
          name
        );
        if (!result.success) throw new Error(result.error);
        updated.push(`${name}${result.changed ? '' : ' (unchanged)'}`);
      }
      const message = `[OK] Marketplace 已更新: ${updated.join(', ')}`;
      sessionActions().addAssistantMessage(message);
      return { success: true, message };
    }

    if (operation === 'remove' || operation === 'rm') {
      const name = parsed.positional[0];
      if (!name) {
        throw new Error('Usage: /plugins marketplace remove <name> --confirm');
      }
      if (!parsed.confirm) {
        throw new Error(`移除 Marketplace ${name} 需要 --confirm`);
      }
      const result = await removePluginMarketplace(name, true);
      if (!result.success) throw new Error(result.error);
      const message = `[OK] 已移除 Marketplace: ${name}`;
      sessionActions().addAssistantMessage(message);
      return { success: true, message };
    }

    throw new Error('Usage: /plugins marketplace <add|list|update|remove> [args]');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionActions().addAssistantMessage(`Marketplace 操作失败: ${message}`);
    return { success: false, error: message };
  }
}

export default pluginsCommand;
