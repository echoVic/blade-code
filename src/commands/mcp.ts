/**
 * MCP 命令 - 完整实现
 * 支持: add, remove, list, get, add-json, reset-project-choices
 */

import os from 'os';
import path from 'path';
import type { CommandModule } from 'yargs';
import type { McpServerConfig } from '../config/types.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { McpConnectionStatus } from '../mcp/types.js';
import { configActions, getMcpServers } from '../store/vanilla.js';

/**
 * 显示 MCP 命令的帮助信息
 */
function showMcpHelp(): void {
  console.log('\nblade mcp\n');
  console.log('管理 MCP 服务器\n');
  console.log('Commands:');
  console.log('  blade mcp add <name> <commandOrUrl> [args...]  添加 MCP 服务器');
  console.log(
    '  blade mcp remove <name>                         删除 MCP 服务器 [aliases: rm]'
  );
  console.log(
    '  blade mcp list                                  列出所有 MCP 服务器并检查健康状态 [aliases: ls]'
  );
  console.log('  blade mcp get <name>                            获取服务器详情');
  console.log(
    '  blade mcp add-json <name> <json>                从 JSON 字符串添加服务器\n'
  );
  console.log('Options:');
  console.log('  -h, --help     显示帮助信息                     [boolean]\n');
  console.log('Examples:');
  console.log('  blade mcp list');
  console.log('  blade mcp add github npx -y @modelcontextprotocol/server-github');
  console.log('  blade mcp add api --transport http http://localhost:3000');
  console.log('  blade mcp remove github\n');
  console.log('使用 blade mcp <command> --help 查看各子命令的详细帮助\n');
}

// 工具函数：解析环境变量数组
function parseEnvArray(envArray: string[]): Record<string, string> {
  return envArray.reduce(
    (acc, item) => {
      const [key, ...valueParts] = item.split('=');
      acc[key] = valueParts.join('=');
      return acc;
    },
    {} as Record<string, string>
  );
}

// 工具函数：解析 HTTP 头数组
function parseHeaderArray(headerArray: string[]): Record<string, string> {
  return headerArray.reduce(
    (acc, item) => {
      const [key, ...valueParts] = item.split(':');
      acc[key.trim()] = valueParts.join(':').trim();
      return acc;
    },
    {} as Record<string, string>
  );
}

// MCP Add 子命令
const mcpAddCommand: CommandModule = {
  command: 'add <name> [commandOrUrl] [args...]',
  describe: '添加 MCP 服务器',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        type: 'string',
        describe: '服务器名称',
        demandOption: true,
      })
      .positional('commandOrUrl', {
        type: 'string',
        describe: 'stdio: 命令 | http/sse: URL',
      })
      .positional('args', {
        type: 'string',
        array: true,
        describe: 'stdio 命令参数',
        default: [],
      })
      .option('transport', {
        alias: 't',
        choices: ['stdio', 'sse', 'http'] as const,
        default: 'stdio' as const,
        describe: '传输类型',
      })
      .option('env', {
        alias: 'e',
        type: 'array',
        describe: '环境变量 (KEY=value)',
      })
      .option('header', {
        alias: 'H',
        type: 'array',
        describe: 'HTTP 头 (Key: Value)',
      })
      .option('timeout', {
        type: 'number',
        describe: '超时时间（毫秒）',
      })
      .option('global', {
        alias: 'g',
        type: 'boolean',
        default: false,
        describe: '存储到全局配置（~/.blade/config.json）',
      })
      .example([
        [
          '$0 mcp add github -- npx -y @modelcontextprotocol/server-github',
          'Add stdio server (recommended)',
        ],
        [
          '$0 mcp add github npx @modelcontextprotocol/server-github -e GITHUB_TOKEN=xxx',
          'Add stdio server with env',
        ],
        [
          '$0 mcp add api --transport http http://localhost:3000 -H "Auth: Bearer token"',
          'Add HTTP server',
        ],
      ]);
  },
  handler: async (argv: any) => {
    try {
      let { name, commandOrUrl, args, transport, env, header, timeout } = argv;
      const isGlobal = argv.global === true;

      // 处理 -- 分隔符的情况
      // 当使用 `blade mcp add name -- command args` 时，yargs 会把 -- 后的内容放到 argv['--'] 中
      if (argv['--'] && argv['--'].length > 0) {
        // argv['--'] = ['command', ...args]
        commandOrUrl = argv['--'][0];
        args = argv['--'].slice(1);
      }

      // 验证必需参数
      if (!name || !commandOrUrl) {
        console.error('❌ 缺少必需参数: name 和 commandOrUrl');
        console.log('\n💡 用法:');
        console.log('  blade mcp add <name> <command> [args...]');
        console.log('  blade mcp add <name> -- <command> [args...]');
        console.log('\n示例:');
        console.log(
          '  blade mcp add github npx -y @modelcontextprotocol/server-github'
        );
        console.log(
          '  blade mcp add github -- npx -y @modelcontextprotocol/server-github'
        );
        process.exit(1);
      }

      const config: McpServerConfig = { type: transport };

      if (transport === 'stdio') {
        config.command = commandOrUrl;
        config.args = args || [];
        if (env && Array.isArray(env)) {
          config.env = parseEnvArray(env as string[]);
        }
      } else {
        config.url = commandOrUrl;
        if (header && Array.isArray(header)) {
          config.headers = parseHeaderArray(header as string[]);
        }
      }

      if (timeout) {
        config.timeout = timeout;
      }

      // 根据 --global 选项决定存储位置
      await configActions().addMcpServer(name, config, {
        scope: isGlobal ? 'global' : 'project',
      });

      const configPath = isGlobal
        ? path.join(os.homedir(), '.blade', 'config.json')
        : path.join(process.cwd(), '.blade', 'config.json');
      console.log(`✅ MCP 服务器 "${name}" 已添加`);
      console.log(`   配置文件: ${configPath}`);
    } catch (error) {
      console.error(
        `❌ 添加失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Remove 子命令
const mcpRemoveCommand: CommandModule = {
  command: 'remove <name>',
  describe: '删除 MCP 服务器',
  aliases: ['rm'],
  builder: (yargs) => {
    return yargs
      .positional('name', {
        type: 'string',
        describe: '服务器名称',
        demandOption: true,
      })
      .option('global', {
        alias: 'g',
        type: 'boolean',
        default: false,
        describe: '从全局配置删除（~/.blade/config.json）',
      })
      .example([['$0 mcp remove github', 'Remove the specified MCP server']]);
  },
  handler: async (argv: any) => {
    try {
      const servers = getMcpServers();
      const isGlobal = argv.global === true;

      if (!servers[argv.name]) {
        console.error(`❌ 服务器 "${argv.name}" 不存在`);
        process.exit(1);
      }

      await configActions().removeMcpServer(argv.name, {
        scope: isGlobal ? 'global' : 'project',
      });
      console.log(`✅ MCP 服务器 "${argv.name}" 已删除`);
    } catch (error) {
      console.error(
        `❌ 删除失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP List 子命令
const mcpListCommand: CommandModule = {
  command: 'list',
  describe: '列出所有 MCP 服务器并检查健康状态',
  aliases: ['ls'],
  handler: async () => {
    try {
      const servers = getMcpServers();

      console.log('');

      if (Object.keys(servers).length === 0) {
        console.log('暂无配置的 MCP 服务器');
        return;
      }

      console.log('检查 MCP 服务器健康状态...\n');

      const mcpRegistry = McpRegistry.getInstance();

      // 尝试连接所有服务器
      const checkPromises = Object.entries(servers).map(async ([name, config]) => {
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

          return { name, config, serverInfo };
        } catch (error) {
          return { name, config, serverInfo: null, error };
        }
      });

      const results = await Promise.all(checkPromises);

      // 显示结果
      for (const { name, config, serverInfo, error } of results) {
        const status = serverInfo?.status || McpConnectionStatus.DISCONNECTED;
        const statusSymbol = status === McpConnectionStatus.CONNECTED ? '✓' : '✗';
        const statusText =
          status === McpConnectionStatus.CONNECTED ? 'Connected' : 'Failed';

        console.log(
          `${name}: ${config.type === 'stdio' ? config.command : config.url} - ${statusSymbol} ${statusText}`
        );

        if (error && status !== McpConnectionStatus.CONNECTED) {
          console.log(
            `  错误: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      console.log('');

      // 断开所有服务器连接并清理
      for (const { name } of results) {
        try {
          await mcpRegistry.unregisterServer(name);
        } catch (_error) {
          // 忽略断开连接时的错误
        }
      }

      // 确保进程退出
      process.exit(0);
    } catch (error) {
      console.error(
        `❌ 列表获取失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Get 子命令
const mcpGetCommand: CommandModule = {
  command: 'get <name>',
  describe: '获取服务器详情',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        type: 'string',
        describe: '服务器名称',
        demandOption: true,
      })
      .example([['$0 mcp get github', 'Get details of the specified server']]);
  },
  handler: async (argv: any) => {
    try {
      const servers = getMcpServers();
      const config = servers[argv.name];

      if (!config) {
        console.error(`❌ 服务器 "${argv.name}" 不存在`);
        process.exit(1);
      }

      console.log(`\n服务器: ${argv.name}\n`);
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error(
        `❌ 获取失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Add-JSON 子命令
const mcpAddJsonCommand: CommandModule = {
  command: 'add-json <name> <json>',
  describe: '从 JSON 字符串添加服务器',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        type: 'string',
        describe: '服务器名称',
        demandOption: true,
      })
      .positional('json', {
        type: 'string',
        describe: 'JSON 配置字符串',
        demandOption: true,
      })
      .option('global', {
        alias: 'g',
        type: 'boolean',
        default: false,
        describe: '存储到全局配置（~/.blade/config.json）',
      })
      .example([
        [
          '$0 mcp add-json my-server \'{"type":"stdio","command":"npx","args":["-y","@example/server"]}\'',
          'Add server from JSON string',
        ],
      ]);
  },
  handler: async (argv: any) => {
    try {
      const serverConfig = JSON.parse(argv.json) as McpServerConfig;
      const isGlobal = argv.global === true;

      if (!serverConfig.type) {
        throw new Error('配置必须包含 "type" 字段');
      }

      await configActions().addMcpServer(argv.name, serverConfig, {
        scope: isGlobal ? 'global' : 'project',
      });

      const configPath = isGlobal
        ? path.join(os.homedir(), '.blade', 'config.json')
        : path.join(process.cwd(), '.blade', 'config.json');
      console.log(`✅ MCP 服务器 "${argv.name}" 已添加`);
      console.log(`   配置文件: ${configPath}`);
    } catch (error) {
      console.error(
        `❌ 添加失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// 主 MCP 命令
export const mcpCommands: CommandModule = {
  command: 'mcp',
  describe: '管理 MCP 服务器',
  builder: (yargs) => {
    return yargs
      .command(mcpAddCommand)
      .command(mcpRemoveCommand)
      .command(mcpListCommand)
      .command(mcpGetCommand)
      .command(mcpAddJsonCommand)
      .demandCommand(0) // 允许不传子命令
      .help(false) // 禁用自动帮助，我们自己处理
      .option('help', {
        alias: 'h',
        type: 'boolean',
        describe: '显示帮助信息',
      });
  },
  handler: (argv: any) => {
    // 检查是否有子命令
    const subcommands = ['add', 'remove', 'list', 'ls', 'get', 'add-json'];
    const hasSubcommand = argv._.some((arg: string) => subcommands.includes(arg));

    // 如果没有子命令或者显式请求帮助，显示帮助信息
    if (!hasSubcommand || argv.help) {
      showMcpHelp();
      process.exit(0);
    }
  },
};
