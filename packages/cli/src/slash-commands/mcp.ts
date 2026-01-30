/**
 * /mcp slash command implementation
 * 显示 MCP 服务器状态和可用工具
 */

import type { McpServerConfig } from '../config/types.js';
import type { McpServerInfo } from '../mcp/McpRegistry.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
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
      '🔌 **MCP 服务器状态**\n\n⚠️ 暂无配置的 MCP 服务器\n\n💡 使用 `blade mcp add` 命令添加 MCP 服务器'
    );
    return;
  }

  ui.sendMessage('🔍 正在检查 MCP 服务器状态...');

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
  let output = '🔌 **MCP 服务器状态**\n\n';
  let connectedCount = 0;
  let disconnectedCount = 0;
  let totalTools = 0;

  for (const [name, serverInfo] of servers) {
    const { config, status, connectedAt, lastError, tools } = serverInfo;
    const statusSymbol = status === McpConnectionStatus.CONNECTED ? '✓' : '✗';
    const statusText =
      status === McpConnectionStatus.CONNECTED ? 'Connected' : 'Disconnected';

    if (status === McpConnectionStatus.CONNECTED) {
      connectedCount++;
      totalTools += tools.length;
    } else {
      disconnectedCount++;
    }

    output += `📦 **${name}**\n`;
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
  output += '💡 使用 `/mcp <server-name>` 查看详细信息\n';
  output += '💡 使用 `/mcp tools` 查看所有工具';

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
    ui.sendMessage(
      `❌ 服务器 "${serverName}" 不存在\n\n💡 使用 \`/mcp\` 查看所有可用服务器`
    );
    return;
  }

  // 尝试连接服务器
  try {
    let serverInfo = mcpRegistry.getServerStatus(serverName);

    if (!serverInfo) {
      ui.sendMessage(`🔍 正在连接 ${serverName}...`);
      await mcpRegistry.registerServer(serverName, config);
      serverInfo = mcpRegistry.getServerStatus(serverName);
    } else if (serverInfo.status === McpConnectionStatus.DISCONNECTED) {
      ui.sendMessage(`🔍 正在重新连接 ${serverName}...`);
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
      `\n⚠️ 连接失败: ${error instanceof Error ? error.message : '未知错误'}`
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
  const { config, status, connectedAt, lastError, tools } = serverInfo;
  const statusSymbol = status === McpConnectionStatus.CONNECTED ? '✓' : '✗';
  const statusText =
    status === McpConnectionStatus.CONNECTED ? 'Connected' : 'Disconnected';

  let output = `📦 **${serverName}**\n\n`;

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
    output += '**工具:**\n  ⚠️ 服务器未连接，无法获取工具列表\n';
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
  let output = `📦 **${serverName}**\n\n`;

  // 连接状态
  output += '**连接状态:**\n';
  output += `  ⏸️ 未启动 (等待 Agent 连接)\n\n`;

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

  output += '\n💡 服务器将在 Agent 启动时自动连接';

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
      '🔧 **可用的 MCP 工具**\n\n⚠️ 暂无配置的 MCP 服务器\n\n💡 使用 `blade mcp add` 命令添加 MCP 服务器'
    );
    return;
  }

  ui.sendMessage('🔍 正在检查 MCP 服务器并获取工具列表...');

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

  let output = '🔧 **可用的 MCP 工具**\n\n';
  let totalTools = 0;

  for (const [name, serverInfo] of servers) {
    const { status, tools } = serverInfo;

    output += `**${name} (${tools.length} 个工具):**\n`;

    if (status !== McpConnectionStatus.CONNECTED) {
      output += '  ⚠️ 服务器未连接\n\n';
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

const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Display MCP server status and available tools',
  fullDescription: '显示 MCP 服务器状态、连接信息和可用工具列表',
  usage: '/mcp [server-name | tools]',
  category: 'MCP',
  examples: [
    '/mcp - 显示所有服务器概览',
    '/mcp chrome-devtools - 显示特定服务器详情',
    '/mcp tools - 显示所有可用工具',
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
