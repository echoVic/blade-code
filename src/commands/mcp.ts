import { Command } from 'commander';
import { McpRegistry } from '../mcp/McpRegistry.js';

export function mcpCommand(program: Command) {
  const mcp = program.command('mcp').description('Configure and manage MCP servers');

  mcp
    .command('list')
    .description('List all configured MCP servers')
    .action(async () => {
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
    });

  mcp
    .command('add')
    .argument('<name>', 'Server name')
    .argument('<config>', 'Server config JSON or file path')
    .description('Add a new MCP server')
    .action(async (name: string, configStr: string) => {
      try {
        const registry = McpRegistry.getInstance();

        // 尝试解析为 JSON，如果失败则当作文件路径
        let config;
        try {
          config = JSON.parse(configStr);
        } catch {
          // 如果不是 JSON，可能是文件路径
          const fs = await import('fs/promises');
          const configContent = await fs.readFile(configStr, 'utf-8');
          config = JSON.parse(configContent);
        }

        await registry.registerServer({ name, ...config });
        console.log(`✅ Added MCP server: ${name}`);
      } catch (error) {
        console.error(
          `❌ Failed to add MCP server: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });

  mcp
    .command('remove')
    .argument('<name>', 'Server name')
    .description('Remove an MCP server')
    .action(async (name: string) => {
      try {
        const registry = McpRegistry.getInstance();
        await registry.unregisterServer(name);
        console.log(`✅ Removed MCP server: ${name}`);
      } catch (error) {
        console.error(
          `❌ Failed to remove MCP server: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });

  mcp
    .command('start')
    .argument('<name>', 'Server name')
    .description('Start an MCP server')
    .action(async (name: string) => {
      try {
        const registry = McpRegistry.getInstance();
        await registry.connectServer(name);
        console.log(`✅ Started MCP server: ${name}`);
      } catch (error) {
        console.error(
          `❌ Failed to start MCP server: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });

  mcp
    .command('stop')
    .argument('<name>', 'Server name')
    .description('Stop an MCP server')
    .action(async (name: string) => {
      try {
        const registry = McpRegistry.getInstance();
        await registry.disconnectServer(name);
        console.log(`✅ Stopped MCP server: ${name}`);
      } catch (error) {
        console.error(
          `❌ Failed to stop MCP server: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });
}
