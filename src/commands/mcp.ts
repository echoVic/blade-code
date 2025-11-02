/**
 * MCP 命令 - 完整实现
 * 支持: add, remove, list, get, add-json, reset-project-choices
 */

import type { CommandModule } from 'yargs';
import { ConfigManager } from '../config/ConfigManager.js';
import type { McpServerConfig } from '../config/types.js';

// 工具函数：解析环境变量数组
function parseEnvArray(envArray: string[]): Record<string, string> {
  return envArray.reduce((acc, item) => {
    const [key, ...valueParts] = item.split('=');
    acc[key] = valueParts.join('=');
    return acc;
  }, {} as Record<string, string>);
}

// 工具函数：解析 HTTP 头数组
function parseHeaderArray(headerArray: string[]): Record<string, string> {
  return headerArray.reduce((acc, item) => {
    const [key, ...valueParts] = item.split(':');
    acc[key.trim()] = valueParts.join(':').trim();
    return acc;
  }, {} as Record<string, string>);
}

// MCP Add 子命令
const mcpAddCommand: CommandModule = {
  command: 'add <name> <commandOrUrl> [args...]',
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
        demandOption: true,
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
      .example([
        [
          '$0 mcp add github npx -y @modelcontextprotocol/server-github -e GITHUB_TOKEN=xxx',
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
      const configManager = ConfigManager.getInstance();
      const { name, commandOrUrl, args, transport, env, header, timeout } = argv;

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

      await configManager.addMcpServer(name, config);
      console.log(`✅ MCP 服务器 "${name}" 已添加到当前项目`);
      console.log(`   项目路径: ${process.cwd()}`);
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
      .example([['$0 mcp remove github', 'Remove the specified MCP server']]);
  },
  handler: async (argv: any) => {
    try {
      const configManager = ConfigManager.getInstance();
      const servers = await configManager.getMcpServers();

      if (!servers[argv.name]) {
        console.error(`❌ 服务器 "${argv.name}" 不存在`);
        process.exit(1);
      }

      await configManager.removeMcpServer(argv.name);
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
  describe: '列出所有 MCP 服务器',
  aliases: ['ls'],
  handler: async () => {
    try {
      const configManager = ConfigManager.getInstance();
      const servers = await configManager.getMcpServers();

      console.log(`\n当前项目: ${process.cwd()}\n`);

      if (Object.keys(servers).length === 0) {
        console.log('暂无配置的 MCP 服务器');
        return;
      }

      console.log('MCP 服务器列表:\n');
      for (const [name, config] of Object.entries(servers)) {
        console.log(`📦 ${name}`);
        console.log(`  类型: ${config.type}`);

        if (config.type === 'stdio') {
          console.log(`  命令: ${config.command} ${config.args?.join(' ') || ''}`);
          if (config.env && Object.keys(config.env).length > 0) {
            console.log(`  环境变量: ${Object.keys(config.env).join(', ')}`);
          }
        } else {
          console.log(`  URL: ${config.url}`);
          if (config.headers) {
            console.log(`  Headers: ${Object.keys(config.headers).length} 个`);
          }
        }

        if (config.timeout) {
          console.log(`  超时: ${config.timeout}ms`);
        }

        console.log('');
      }
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
      const configManager = ConfigManager.getInstance();
      const servers = await configManager.getMcpServers();
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
      .example([
        [
          '$0 mcp add-json my-server \'{"type":"stdio","command":"npx","args":["-y","@example/server"]}\'',
          'Add server from JSON string',
        ],
      ]);
  },
  handler: async (argv: any) => {
    try {
      const configManager = ConfigManager.getInstance();

      const serverConfig = JSON.parse(argv.json) as McpServerConfig;

      if (!serverConfig.type) {
        throw new Error('配置必须包含 "type" 字段');
      }

      await configManager.addMcpServer(argv.name, serverConfig);
      console.log(`✅ MCP 服务器 "${argv.name}" 已添加`);
      console.log(`   项目路径: ${process.cwd()}`);
    } catch (error) {
      console.error(
        `❌ 添加失败: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Reset-Project-Choices 子命令
const mcpResetProjectChoicesCommand: CommandModule = {
  command: 'reset-project-choices',
  describe: '重置项目级 .mcp.json 确认记录',
  handler: async () => {
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.resetProjectChoices();
      console.log(`✅ 已重置当前项目的 .mcp.json 确认记录`);
      console.log(`   项目路径: ${process.cwd()}`);
    } catch (error) {
      console.error(
        `❌ 重置失败: ${error instanceof Error ? error.message : '未知错误'}`
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
      .command(mcpResetProjectChoicesCommand)
      .demandCommand(1, '请指定子命令')
      .help()
      .example([
        ['$0 mcp list', 'List all MCP servers'],
        ['$0 mcp add github npx -y @modelcontextprotocol/server-github', 'Add stdio server'],
        ['$0 mcp add api --transport http http://localhost:3000', 'Add HTTP server'],
        ['$0 mcp remove github', 'Remove server'],
      ]);
  },
  handler: () => {
    // 如果没有子命令，yargs 会自动显示帮助
  },
};
