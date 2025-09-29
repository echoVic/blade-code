/**
 * MCP 命令 - Yargs 版本
 */

import type { CommandModule } from 'yargs';
import { McpRegistry } from '../mcp/McpRegistry.js';
import type {
  McpListOptions,
  McpAddOptions,
  McpRemoveOptions,
  McpStartOptions,
  McpStopOptions
} from '../cli/types.js';

// MCP List 子命令
const mcpListCommand: CommandModule<{}, McpListOptions> = {
  command: 'list',
  describe: 'List all configured MCP servers',
  aliases: ['ls'],
  handler: async () => {
    try {
      const registry = McpRegistry.getInstance();
      const serversMap = registry.getAllServers();

      if (serversMap.size === 0) {
        console.log('No MCP servers configured');
        return;
      }

      console.log('Configured MCP servers:');
      const servers = Array.from(serversMap.entries()).map(([name, server]) => ({
        name,
        status: server.status,
        command: server.config?.command || 'unknown',
        connectedAt: server.connectedAt?.toISOString() || 'never',
      }));
      console.table(servers);
    } catch (error) {
      console.error(
        `❌ Failed to list MCP servers: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Add 子命令
const mcpAddCommand: CommandModule<{}, McpAddOptions> = {
  command: 'add <name> <config>',
  describe: 'Add a new MCP server',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        describe: 'Server name',
        type: 'string',
        demandOption: true,
      })
      .positional('config', {
        describe: 'Server config JSON or file path',
        type: 'string',
        demandOption: true,
      })
      .example([
        ['$0 mcp add myserver \'{"command": "node", "args": ["server.js"]}\'', 'Add server with JSON config'],
        ['$0 mcp add myserver config.json', 'Add server from config file'],
      ]);
  },
  handler: async (argv) => {
    try {
      const registry = McpRegistry.getInstance();

      // 尝试解析为 JSON，如果失败则当作文件路径
      let config;
      try {
        config = JSON.parse(argv.config);
      } catch {
        // 如果不是 JSON，可能是文件路径
        const fs = await import('fs/promises');
        const configContent = await fs.readFile(argv.config, 'utf-8');
        config = JSON.parse(configContent);
      }

      await registry.registerServer({ name: argv.name, ...config });
      console.log(`✅ Added MCP server: ${argv.name}`);
    } catch (error) {
      console.error(
        `❌ Failed to add MCP server: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Remove 子命令
const mcpRemoveCommand: CommandModule<{}, McpRemoveOptions> = {
  command: 'remove <name>',
  describe: 'Remove an MCP server',
  aliases: ['rm'],
  builder: (yargs) => {
    return yargs
      .positional('name', {
        describe: 'Server name to remove',
        type: 'string',
        demandOption: true,
      })
      .example([
        ['$0 mcp remove myserver', 'Remove the specified MCP server'],
      ]);
  },
  handler: async (argv) => {
    try {
      const registry = McpRegistry.getInstance();
      await registry.unregisterServer(argv.name);
      console.log(`✅ Removed MCP server: ${argv.name}`);
    } catch (error) {
      console.error(
        `❌ Failed to remove MCP server: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Start 子命令
const mcpStartCommand: CommandModule<{}, McpStartOptions> = {
  command: 'start <name>',
  describe: 'Start an MCP server',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        describe: 'Server name to start',
        type: 'string',
        demandOption: true,
      })
      .example([
        ['$0 mcp start myserver', 'Start the specified MCP server'],
      ]);
  },
  handler: async (argv) => {
    try {
      const registry = McpRegistry.getInstance();
      await registry.connectServer(argv.name);
      console.log(`✅ Started MCP server: ${argv.name}`);
    } catch (error) {
      console.error(
        `❌ Failed to start MCP server: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// MCP Stop 子命令
const mcpStopCommand: CommandModule<{}, McpStopOptions> = {
  command: 'stop <name>',
  describe: 'Stop an MCP server',
  builder: (yargs) => {
    return yargs
      .positional('name', {
        describe: 'Server name to stop',
        type: 'string',
        demandOption: true,
      })
      .example([
        ['$0 mcp stop myserver', 'Stop the specified MCP server'],
      ]);
  },
  handler: async (argv) => {
    try {
      const registry = McpRegistry.getInstance();
      await registry.disconnectServer(argv.name);
      console.log(`✅ Stopped MCP server: ${argv.name}`);
    } catch (error) {
      console.error(
        `❌ Failed to stop MCP server: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};

// 主 MCP 命令
export const mcpCommands: CommandModule = {
  command: 'mcp',
  describe: 'Configure and manage MCP servers',
  builder: (yargs) => {
    return yargs
      .command(mcpListCommand)
      .command(mcpAddCommand)
      .command(mcpRemoveCommand)
      .command(mcpStartCommand)
      .command(mcpStopCommand)
      .demandCommand(1, 'You need to specify a subcommand')
      .help()
      .example([
        ['$0 mcp list', 'List all MCP servers'],
        ['$0 mcp add myserver config.json', 'Add MCP server from file'],
        ['$0 mcp start myserver', 'Start MCP server'],
      ]);
  },
  handler: () => {
    // 如果没有子命令，显示帮助
  },
};