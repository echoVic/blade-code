/**
 * /mcp slash command implementation
 * 显示 MCP 服务器状态和可用工具
 */

import type { McpServerConfig } from '../config/types.js';
import { isMcpLogLevel, MCP_LOG_LEVELS, type McpLogLevel } from '../mcp/McpLogging.js';
import type { McpServerInfo } from '../mcp/McpRegistry.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { createMcpProviderToolName } from '../mcp/McpToolCatalog.js';
import { McpConnectionStatus } from '../mcp/types.js';
import { getMcpServers } from '../store/vanilla.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
  type SlashCommandUI,
} from './types.js';

/**
 * 格式化时间差（例如：2.3s ago, 5m ago）
 */
function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * 显示所有服务器概览
 */
async function showServersOverview(ui: SlashCommandUI): Promise<void> {
  const mcpRegistry = McpRegistry.getInstance();

  // 从 Store 读取配置
  const configuredServers = getMcpServers();

  if (Object.keys(configuredServers).length === 0) {
    ui.sendMessage(
      '**MCP 服务器状态**\n\n[WARN] 暂无配置的 MCP 服务器\n\n使用 `blade mcp add` 命令添加 MCP 服务器'
    );
    return;
  }

  ui.sendMessage('正在检查 MCP 服务器状态...');

  // 尝试连接所有配置的服务器
  const checkPromises = Object.entries(configuredServers).map(
    async ([name, config]) => {
      try {
        // 检查服务器是否已注册
        let serverInfo = mcpRegistry.getServerStatus(name);

        if (!serverInfo) {
          // 如果未注册，先注册
          await mcpRegistry.registerServer(name, config);
          serverInfo = mcpRegistry.getServerStatus(name);
        } else if (serverInfo.status === McpConnectionStatus.DISCONNECTED) {
          // 如果已注册但未连接，尝试连接
          await mcpRegistry.connectServer(name);
        }

        return { name, config, serverInfo: mcpRegistry.getServerStatus(name) };
      } catch (error) {
        return { name, config, serverInfo: null, error };
      }
    }
  );

  await Promise.all(checkPromises);

  // 显示结果
  showServersFromRegistry(ui, mcpRegistry.getAllServers());
}

/**
 * 从 Registry 显示服务器（已连接的状态）
 */
function showServersFromRegistry(
  ui: SlashCommandUI,
  servers: Map<string, McpServerInfo>
): void {
  let output = '**MCP 服务器状态**\n\n';
  let connectedCount = 0;
  let disconnectedCount = 0;
  let totalTools = 0;

  for (const [name, serverInfo] of servers) {
    const { config, status, connectedAt, lastError, recovery, tools } = serverInfo;
    const statusSymbol =
      status === McpConnectionStatus.CONNECTED
        ? '[OK]'
        : status === McpConnectionStatus.RECONNECTING
          ? '[WAIT]'
          : '[FAIL]';
    const statusText =
      status === McpConnectionStatus.CONNECTED
        ? 'Connected'
        : status === McpConnectionStatus.RECONNECTING
          ? `Recovering ${recovery?.attempt ?? 0}/${recovery?.maxAttempts ?? 0}`
          : 'Disconnected';

    if (status === McpConnectionStatus.CONNECTED) {
      connectedCount++;
      totalTools += tools.length;
    } else {
      disconnectedCount++;
    }

    output += `**${name}**\n`;
    output += `  状态: ${statusSymbol} ${statusText}\n`;
    output += `  类型: ${config.type}\n`;

    if (config.type === 'stdio') {
      output += `  命令: ${config.command}${config.args?.length ? ' ' + config.args.join(' ') : ''}\n`;
    } else {
      output += `  URL: ${config.url}\n`;
    }

    output += `  工具: ${tools.length} 个\n`;

    if (connectedAt && status === McpConnectionStatus.CONNECTED) {
      output += `  连接时间: ${formatTimeSince(connectedAt)}\n`;
    }

    if (lastError && status !== McpConnectionStatus.CONNECTED) {
      output += `  错误: ${lastError.message}\n`;
    }

    output += '\n';
  }

  output += '**总计:**\n';
  output += `- 服务器: ${servers.size} 个 (${connectedCount} 连接, ${disconnectedCount} 断开)\n`;
  output += `- 可用工具: ${totalTools} 个\n\n`;
  output += '使用 `/mcp <server-name>` 查看详细信息\n';
  output += '使用 `/mcp tools` 查看所有工具';

  ui.sendMessage(output);
}

/**
 * 显示特定服务器详情
 */
async function showServerDetails(
  ui: SlashCommandUI,
  serverName: string
): Promise<void> {
  const mcpRegistry = McpRegistry.getInstance();

  // 从 Store 读取配置
  const servers = getMcpServers();
  const config = servers[serverName];

  if (!config) {
    ui.sendMessage(`服务器 "${serverName}" 不存在\n\n使用 \`/mcp\` 查看所有可用服务器`);
    return;
  }

  // 尝试连接服务器
  try {
    let serverInfo = mcpRegistry.getServerStatus(serverName);

    if (!serverInfo) {
      ui.sendMessage(`正在连接 ${serverName}...`);
      await mcpRegistry.registerServer(serverName, config);
      serverInfo = mcpRegistry.getServerStatus(serverName);
    } else if (serverInfo.status === McpConnectionStatus.DISCONNECTED) {
      ui.sendMessage(`正在重新连接 ${serverName}...`);
      await mcpRegistry.connectServer(serverName);
      serverInfo = mcpRegistry.getServerStatus(serverName);
    }

    // 显示运行时状态
    if (serverInfo) {
      showServerDetailsFromRegistry(ui, serverName, serverInfo);
    } else {
      // 如果连接失败，显示配置详情
      showServerDetailsFromConfig(ui, serverName, config);
    }
  } catch (error) {
    // 连接失败，显示配置详情和错误信息
    showServerDetailsFromConfig(ui, serverName, config);
    ui.sendMessage(
      `\n[WARN] 连接失败: ${error instanceof Error ? error.message : '未知错误'}`
    );
  }
}

/**
 * 从 Registry 显示服务器详情
 */
function showServerDetailsFromRegistry(
  ui: SlashCommandUI,
  serverName: string,
  serverInfo: McpServerInfo
): void {
  const { config, status, connectedAt, lastError, recovery, tools } = serverInfo;
  const statusSymbol =
    status === McpConnectionStatus.CONNECTED
      ? '[OK]'
      : status === McpConnectionStatus.RECONNECTING
        ? '[WAIT]'
        : '[FAIL]';
  const statusText =
    status === McpConnectionStatus.CONNECTED
      ? 'Connected'
      : status === McpConnectionStatus.RECONNECTING
        ? `Recovering ${recovery?.attempt ?? 0}/${recovery?.maxAttempts ?? 0}`
        : 'Disconnected';

  let output = `**${serverName}**\n\n`;

  // 连接状态
  output += '**连接状态:**\n';
  output += `  ${statusSymbol} ${statusText}`;
  if (connectedAt && status === McpConnectionStatus.CONNECTED) {
    output += ` (连接于 ${formatTimeSince(connectedAt)})`;
  }
  output += '\n\n';

  // 配置信息
  output += '**配置信息:**\n';
  output += `  类型: ${config.type}\n`;

  if (config.type === 'stdio') {
    output += `  命令: ${config.command}\n`;
    if (config.args && config.args.length > 0) {
      output += `  参数: ${config.args.join(' ')}\n`;
    }
    if (config.env && Object.keys(config.env).length > 0) {
      output += `  环境变量: ${Object.keys(config.env).length} 个\n`;
    }
  } else {
    output += `  URL: ${config.url}\n`;
    if (config.headers && Object.keys(config.headers).length > 0) {
      output += `  Headers: ${Object.keys(config.headers).length} 个\n`;
    }
  }

  if (config.timeout) {
    output += `  超时: ${config.timeout}ms\n`;
  }

  output += '\n';

  // 工具列表
  if (status === McpConnectionStatus.CONNECTED) {
    output += `**可用工具 (${tools.length}):**\n`;
    if (tools.length === 0) {
      output += '  (无)\n';
    } else {
      for (const tool of tools) {
        output += `  • ${tool.name}`;
        if (tool.description) {
          output += ` - ${tool.description}`;
        }
        output += '\n';
      }
    }
  } else {
    output += '**工具:**\n  [WARN] 服务器未连接，无法获取工具列表\n';
  }

  // 错误信息
  if (lastError) {
    output += '\n**错误信息:**\n';
    output += `  ${lastError.message}`;
  }

  ui.sendMessage(output);
}

/**
 * 从配置显示服务器详情
 */
function showServerDetailsFromConfig(
  ui: SlashCommandUI,
  serverName: string,
  config: McpServerConfig
): void {
  let output = `**${serverName}**\n\n`;

  // 连接状态
  output += '**连接状态:**\n';
  output += `  未启动 (等待 Agent 连接)\n\n`;

  // 配置信息
  output += '**配置信息:**\n';
  output += `  类型: ${config.type}\n`;

  if (config.type === 'stdio') {
    output += `  命令: ${config.command}\n`;
    if (config.args && config.args.length > 0) {
      output += `  参数: ${config.args.join(' ')}\n`;
    }
    if (config.env && Object.keys(config.env).length > 0) {
      output += `  环境变量: ${Object.keys(config.env).join(', ')}\n`;
    }
  } else {
    output += `  URL: ${config.url}\n`;
    if (config.headers && Object.keys(config.headers).length > 0) {
      output += `  Headers: ${Object.keys(config.headers).join(', ')}\n`;
    }
  }

  if (config.timeout) {
    output += `  超时: ${config.timeout}ms\n`;
  }

  output += '\n服务器将在 Agent 启动时自动连接';

  ui.sendMessage(output);
}

/**
 * 显示所有可用工具
 */
async function showAllTools(ui: SlashCommandUI): Promise<void> {
  const mcpRegistry = McpRegistry.getInstance();

  // 从 Store 读取配置
  const configuredServers = getMcpServers();

  if (Object.keys(configuredServers).length === 0) {
    ui.sendMessage(
      '**可用的 MCP 工具**\n\n[WARN] 暂无配置的 MCP 服务器\n\n使用 `blade mcp add` 命令添加 MCP 服务器'
    );
    return;
  }

  ui.sendMessage('正在检查 MCP 服务器并获取工具列表...');

  // 尝试连接所有配置的服务器
  const checkPromises = Object.entries(configuredServers).map(
    async ([name, config]) => {
      try {
        let serverInfo = mcpRegistry.getServerStatus(name);

        if (!serverInfo) {
          await mcpRegistry.registerServer(name, config);
          serverInfo = mcpRegistry.getServerStatus(name);
        } else if (serverInfo.status === McpConnectionStatus.DISCONNECTED) {
          await mcpRegistry.connectServer(name);
        }

        return { name, config, serverInfo: mcpRegistry.getServerStatus(name) };
      } catch (error) {
        return { name, config, serverInfo: null, error };
      }
    }
  );

  await Promise.all(checkPromises);

  // 获取所有服务器
  const servers = mcpRegistry.getAllServers();

  let output = '**可用的 MCP 工具**\n\n';
  let totalTools = 0;

  for (const [name, serverInfo] of servers) {
    const { status, tools } = serverInfo;

    output += `**${name} (${tools.length} 个工具):**\n`;

    if (status !== McpConnectionStatus.CONNECTED) {
      output += '  [WARN] 服务器未连接\n\n';
      continue;
    }

    if (tools.length === 0) {
      output += '  (无)\n\n';
      continue;
    }

    totalTools += tools.length;

    for (const tool of tools) {
      output += `  • ${tool.name}`;
      if (tool.description) {
        // 限制描述长度，避免输出过长
        const desc =
          tool.description.length > 60
            ? tool.description.substring(0, 57) + '...'
            : tool.description;
        output += ` - ${desc}`;
      }
      output += '\n';
    }

    output += '\n';
  }

  output += `**总计:** ${totalTools} 个工具可用`;

  ui.sendMessage(output);
}

async function showContentCatalog(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  kind: 'resources' | 'prompts',
  serverName?: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP content commands require an active Session runtime');
  }
  await context.mcp.refresh(serverName);
  const catalog = await context.mcp.getCatalog();
  const entries =
    kind === 'resources'
      ? {
          resources: catalog.resources.filter(
            (entry) => !serverName || entry.server === serverName
          ),
          resourceTemplates: catalog.resourceTemplates.filter(
            (entry) => !serverName || entry.server === serverName
          ),
        }
      : {
          prompts: catalog.prompts.filter(
            (entry) => !serverName || entry.server === serverName
          ),
        };
  const output = `**MCP ${kind} (revision ${catalog.revision})**\n\n\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\``;
  ui.sendMessage(output);
  return output;
}

function parsePromptArguments(values: readonly string[]): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(
        `Prompt arguments must use key=value syntax; received "${value}"`
      );
    }
    const key = value.slice(0, separator);
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error(`Unsafe prompt argument name "${key}"`);
    }
    if (Object.hasOwn(result, key)) {
      throw new Error(`Duplicate prompt argument "${key}"`);
    }
    result[key] = value.slice(separator + 1);
  }
  return result;
}

async function resolvePrompt(
  context: SlashCommandContext,
  serverName: string,
  promptName: string,
  values: readonly string[]
): Promise<SlashCommandResult> {
  if (!context.mcp) {
    throw new Error('MCP prompt commands require an active Session runtime');
  }
  await context.mcp.refresh(serverName);
  const result = await context.mcp.getPrompt(
    serverName,
    promptName,
    parsePromptArguments(values)
  );
  const processedContent = result.messages
    .map(
      (message) => `## ${message.role}\n\n${JSON.stringify(message.content, null, 2)}`
    )
    .join('\n\n');
  const content = [
    `# MCP Prompt: ${serverName}:${promptName}`,
    result.description ?? '',
    processedContent,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    success: true,
    message: `Resolved MCP prompt ${serverName}:${promptName}`,
    content,
    data: {
      action: 'invoke_custom_command',
      commandName: createMcpProviderToolName(serverName, promptName),
      processedContent: content,
      config: {
        description: result.description ?? `MCP prompt ${promptName}`,
      },
    },
  };
}

async function completeArgument(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  serverName: string,
  referenceType: 'prompt' | 'resource',
  referenceValue: string,
  argumentName: string,
  value: string,
  contextValues: readonly string[]
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP completion requires an active Session runtime');
  }
  await context.mcp.refresh(serverName);
  const result = await context.mcp.complete(
    serverName,
    {
      reference:
        referenceType === 'prompt'
          ? { type: 'prompt', name: referenceValue }
          : { type: 'resource', uri: referenceValue },
      argument: {
        name: argumentName,
        value,
      },
      context: parsePromptArguments(contextValues),
    },
    context.signal
  );
  const output = [
    `**MCP completion: ${serverName}:${referenceValue} · ${argumentName}**`,
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
  ].join('\n');
  ui.sendMessage(output);
  return output;
}

async function showMcpTasks(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  serverName?: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP task commands require an active Session runtime');
  }
  const tasks = await context.mcp.listTasks(serverName);
  const projected = tasks.map(({ result: _result, ...task }) => task);
  const output = [
    `**MCP tasks${serverName ? ` · ${serverName}` : ''}**`,
    '',
    '```json',
    JSON.stringify(projected, null, 2),
    '```',
  ].join('\n');
  ui.sendMessage(output);
  return output;
}

async function showMcpTask(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  taskId: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP task commands require an active Session runtime');
  }
  const task = await context.mcp.getTask(taskId);
  if (!task) throw new Error(`Unknown MCP task ID: ${taskId}`);
  const output = [
    `**MCP task · ${taskId}**`,
    '',
    '```json',
    JSON.stringify(task, null, 2),
    '```',
  ].join('\n');
  ui.sendMessage(output);
  return output;
}

async function cancelMcpTask(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  taskId: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP task commands require an active Session runtime');
  }
  const task = await context.mcp.cancelTask(taskId, context.signal);
  if (!task) throw new Error(`Unknown MCP task ID: ${taskId}`);
  const output = `MCP task ${taskId}: ${task.status}`;
  ui.sendMessage(output);
  return output;
}

async function showSessionLogs(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  serverName?: string,
  requestedLimit?: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP log commands require an active Session runtime');
  }
  const parsedLimit = requestedLimit ? Number(requestedLimit) : 20;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
    throw new Error('MCP log limit must be an integer between 1 and 50');
  }
  const snapshot = await context.mcp.getLogs(serverName, {
    limit: parsedLimit,
  });
  const lines =
    snapshot.entries.length === 0
      ? ['(no MCP logs captured)']
      : snapshot.entries.map((entry) => {
          const source = entry.logger
            ? `${entry.serverName}/${entry.logger}`
            : entry.serverName;
          const flags = [
            entry.truncated ? 'truncated' : '',
            entry.detailsOmitted ? 'details-omitted' : '',
            entry.synthetic ? 'synthetic' : '',
          ].filter(Boolean);
          return [
            `[${entry.level}] ${source} · r${entry.revision}`,
            entry.message.slice(0, 2_000),
            `sha256=${entry.dataSha256}${flags.length ? ` · ${flags.join(',')}` : ''}`,
          ].join('\n');
        });
  const output = [
    `**MCP logs (revision ${snapshot.revision})**`,
    '',
    lines.join('\n\n'),
  ].join('\n');
  ui.sendMessage(output);
  return output;
}

async function setSessionLogLevel(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  serverName: string,
  level: McpLogLevel
): Promise<void> {
  if (!context.mcp) {
    throw new Error('MCP log commands require an active Session runtime');
  }
  await context.mcp.setLoggingLevel(serverName, level);
  ui.sendMessage(`[OK] ${serverName} MCP logging level set to ${level}`);
}

async function showSessionInstructions(
  ui: SlashCommandUI,
  context: SlashCommandContext,
  serverName?: string
): Promise<string> {
  if (!context.mcp) {
    throw new Error('MCP instruction commands require an active Session runtime');
  }
  const snapshot = await context.mcp.getInstructions();
  const entries = snapshot.instructions.filter(
    (instruction) => !serverName || instruction.serverName === serverName
  );
  const blocks =
    entries.length === 0
      ? ['(no MCP server instructions)']
      : entries.map((instruction) =>
          [
            `## ${instruction.serverName}`,
            instruction.text ?? '[details omitted by runtime policy]',
            `sha256=${instruction.sha256}` +
              `${instruction.truncated ? ' · truncated' : ''}`,
          ].join('\n')
        );
  const output = [
    `**MCP server instructions (revision ${snapshot.revision})**`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
  ui.sendMessage(output);
  return output;
}

async function loginOAuth(
  ui: SlashCommandUI,
  serverName: string,
  context: SlashCommandContext
): Promise<void> {
  if (context.surface !== 'tui') {
    throw new Error(
      'MCP OAuth login requires an explicit local TUI action or "blade mcp login"'
    );
  }
  const config = getMcpServers()[serverName];
  if (!config) throw new Error(`服务器 "${serverName}" 不存在`);

  const registry = McpRegistry.getInstance();
  const temporaryRegistration = !registry.getServerStatus(serverName);
  try {
    if (temporaryRegistration) {
      await registry.registerServer(serverName, config, { connect: false });
    }
    const handle = await registry.beginOAuthLogin(serverName, {
      openBrowser: true,
    });
    ui.sendMessage(
      `已在浏览器中打开 ${serverName} 的 OAuth 授权页面。\n\n备用链接: ${handle.authorizationUrl}`
    );
    await handle.completion;
    ui.sendMessage(`[OK] ${serverName} OAuth 登录成功`);
  } finally {
    if (temporaryRegistration) await registry.unregisterServer(serverName);
  }
}

async function logoutOAuth(
  ui: SlashCommandUI,
  serverName: string,
  context: SlashCommandContext
): Promise<void> {
  if (context.surface !== 'tui') {
    throw new Error(
      'MCP OAuth logout requires an explicit local TUI action or "blade mcp logout"'
    );
  }
  const config = getMcpServers()[serverName];
  if (!config) throw new Error(`服务器 "${serverName}" 不存在`);

  const registry = McpRegistry.getInstance();
  const temporaryRegistration = !registry.getServerStatus(serverName);
  try {
    if (temporaryRegistration) {
      await registry.registerServer(serverName, config, { connect: false });
    }
    await registry.logoutOAuth(serverName);
    ui.sendMessage(`[OK] ${serverName} OAuth 凭证已清除`);
  } finally {
    if (temporaryRegistration) await registry.unregisterServer(serverName);
  }
}

const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Display MCP server status and available tools',
  fullDescription: '显示 MCP 服务器状态、连接信息和可用工具列表',
  usage:
    '/mcp [server-name | tools | resources [server] | prompts [server] | ' +
    'prompt <server> <name> [key=value...] | logs [server] [limit] | ' +
    'complete <server> <prompt|resource> <reference> <argument> [value] ' +
    '[key=value...] | tasks [server] | task <task-id> | ' +
    'task-cancel <task-id> | log-level <server> <level> | ' +
    'instructions [server] | login <server> | logout <server>]',
  category: 'MCP',
  examples: [
    '/mcp - 显示所有服务器概览',
    '/mcp chrome-devtools - 显示特定服务器详情',
    '/mcp tools - 显示所有可用工具',
    '/mcp resources [server] - 显示 Session MCP 资源与模板',
    '/mcp prompts [server] - 显示 Session MCP prompts',
    '/mcp prompt server name key=value - 解析并执行 MCP prompt',
    '/mcp complete server prompt name argument partial key=value - 补全参数',
    '/mcp tasks [server] - 列出当前 Session 拥有的 MCP tasks',
    '/mcp task mcp_task_xxx - 查看安全 task 状态与结果',
    '/mcp task-cancel mcp_task_xxx - 取消 MCP task',
    '/mcp logs [server] [limit] - 显示当前 Session 的安全 MCP 日志',
    `/mcp log-level server <${MCP_LOG_LEVELS.join('|')}> - 调整日志级别`,
    '/mcp instructions [server] - 显示当前 Session 的 MCP server instructions',
    '/mcp login remote-server - 显式启动 OAuth 登录',
    '/mcp logout remote-server - 清除 OAuth 凭证',
  ],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const ui = getUI(context);

    try {
      // 调试信息：显示接收到的参数
      console.log('[MCP Command] Received args:', args);

      // 无参数：显示服务器概览
      if (args.length === 0) {
        await showServersOverview(ui);
        return {
          success: true,
          message: 'MCP 服务器概览已显示',
        };
      }

      const subcommand = args[0];
      console.log('[MCP Command] Subcommand:', subcommand);

      // /mcp tools - 显示所有工具
      if (subcommand === 'tools') {
        await showAllTools(ui);
        return {
          success: true,
          message: 'MCP 工具列表已显示',
        };
      }

      if (subcommand === 'resources' || subcommand === 'prompts') {
        const content = await showContentCatalog(ui, context, subcommand, args[1]);
        return {
          success: true,
          message: `MCP ${subcommand} 已显示`,
          content,
        };
      }

      if (subcommand === 'prompt') {
        const serverName = args[1];
        const promptName = args[2];
        if (!serverName || !promptName) {
          return {
            success: false,
            error: '用法: /mcp prompt <server> <name> [key=value...]',
          };
        }
        return await resolvePrompt(context, serverName, promptName, args.slice(3));
      }

      if (subcommand === 'complete') {
        const serverName = args[1];
        const referenceType = args[2];
        const referenceValue = args[3];
        const argumentName = args[4];
        if (
          !serverName ||
          (referenceType !== 'prompt' && referenceType !== 'resource') ||
          !referenceValue ||
          !argumentName
        ) {
          return {
            success: false,
            error:
              '用法: /mcp complete <server> <prompt|resource> ' +
              '<reference> <argument> [value] [key=value...]',
          };
        }
        const content = await completeArgument(
          ui,
          context,
          serverName,
          referenceType,
          referenceValue,
          argumentName,
          args[5] ?? '',
          args.slice(6)
        );
        return {
          success: true,
          message: `MCP completion returned for "${argumentName}"`,
          content,
        };
      }

      if (subcommand === 'tasks') {
        const content = await showMcpTasks(ui, context, args[1]);
        return {
          success: true,
          message: 'MCP tasks displayed',
          content,
        };
      }

      if (subcommand === 'task' || subcommand === 'task-cancel') {
        const taskId = args[1];
        if (!taskId) {
          return {
            success: false,
            error: `用法: /mcp ${subcommand} <mcp-task-id>`,
          };
        }
        const content =
          subcommand === 'task'
            ? await showMcpTask(ui, context, taskId)
            : await cancelMcpTask(ui, context, taskId);
        return {
          success: true,
          message:
            subcommand === 'task'
              ? `MCP task "${taskId}" displayed`
              : `MCP task "${taskId}" cancelled`,
          content,
        };
      }

      if (subcommand === 'logs') {
        const content = await showSessionLogs(ui, context, args[1], args[2]);
        return {
          success: true,
          message: 'MCP logs displayed',
          content,
        };
      }

      if (subcommand === 'log-level') {
        const serverName = args[1];
        const level = args[2];
        if (!serverName || !isMcpLogLevel(level)) {
          return {
            success: false,
            error: '用法: /mcp log-level <server> ' + `<${MCP_LOG_LEVELS.join('|')}>`,
          };
        }
        await setSessionLogLevel(ui, context, serverName, level);
        return {
          success: true,
          message: `MCP logging level set to ${level} for "${serverName}"`,
        };
      }

      if (subcommand === 'instructions') {
        const content = await showSessionInstructions(ui, context, args[1]);
        return {
          success: true,
          message: 'MCP server instructions displayed',
          content,
        };
      }

      if (subcommand === 'login' || subcommand === 'logout') {
        const serverName = args[1];
        if (!serverName) {
          return {
            success: false,
            error: `用法: /mcp ${subcommand} <server-name>`,
          };
        }
        if (subcommand === 'login') {
          await loginOAuth(ui, serverName, context);
        } else {
          await logoutOAuth(ui, serverName, context);
        }
        return {
          success: true,
          message: `MCP OAuth ${subcommand} completed for "${serverName}"`,
        };
      }

      // /mcp <server-name> - 显示服务器详情
      await showServerDetails(ui, subcommand);
      return {
        success: true,
        message: `服务器 "${subcommand}" 详情已显示`,
      };
    } catch (error) {
      return {
        success: false,
        error: `显示 MCP 信息失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  },
};

export default mcpCommand;
