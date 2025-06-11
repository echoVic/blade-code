import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { MCPClient, mcpConfig, MCPConnectionConfig, MCPServer } from '../mcp/index.js';
import { createToolManager } from '../tools/index.js';

/**
 * MCP 相关命令
 */
export function mcpCommand(program: Command): void {
  const mcpCmd = program.command('mcp').description('🔗 MCP (Model Context Protocol) 管理命令');

  // MCP 服务器命令
  const serverCmd = mcpCmd.command('server').description('MCP 服务器管理');

  serverCmd
    .command('start')
    .description('启动 MCP 服务器')
    .option('-p, --port <port>', '监听端口', '3001')
    .option('-h, --host <host>', '监听地址', 'localhost')
    .option('-t, --transport <type>', '传输类型 (ws|stdio)', 'ws')
    .action(async options => {
      try {
        const serverConfig = mcpConfig.getServerConfig();
        const config = {
          port: parseInt(options.port) || serverConfig.port,
          host: options.host || serverConfig.host,
          transport: options.transport || serverConfig.transport,
          auth: serverConfig.auth,
        };

        const toolManager = createToolManager();
        const server = new MCPServer(config, toolManager);

        console.log(chalk.blue('🚀 启动 MCP 服务器...'));
        console.log(chalk.gray(`   传输方式: ${config.transport}`));

        if (config.transport === 'ws') {
          console.log(chalk.gray(`   监听地址: ws://${config.host}:${config.port}`));
        }

        await server.start();

        server.on('started', info => {
          console.log(chalk.green('✅ MCP 服务器启动成功'));
          if (info.host && info.port) {
            console.log(chalk.cyan(`🌐 服务器地址: ws://${info.host}:${info.port}`));
          }
          console.log(chalk.yellow('💡 提示: 按 Ctrl+C 停止服务器'));
        });

        server.on('error', error => {
          console.error(chalk.red('❌ 服务器错误:'), error.message);
        });

        // 处理退出信号
        process.on('SIGINT', async () => {
          console.log(chalk.yellow('\n⏹️  正在停止服务器...'));
          await server.stop();
          console.log(chalk.green('✅ 服务器已停止'));
          process.exit(0);
        });
      } catch (error) {
        console.error(
          chalk.red('❌ 启动服务器失败:'),
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    });

  // MCP 客户端命令
  const clientCmd = mcpCmd.command('client').description('MCP 客户端管理');

  clientCmd
    .command('connect <server>')
    .description('连接到 MCP 服务器')
    .option('-i, --interactive', '交互式模式')
    .action(async (serverName, options) => {
      try {
        const serverConfig = mcpConfig.getServer(serverName);
        if (!serverConfig) {
          console.error(chalk.red(`❌ 未找到服务器配置: ${serverName}`));
          console.log(chalk.yellow('💡 使用 "blade mcp config add" 添加服务器配置'));
          return;
        }

        const client = new MCPClient();

        console.log(chalk.blue('🔗 连接到 MCP 服务器...'));
        console.log(chalk.gray(`   服务器: ${serverName}`));
        console.log(chalk.gray(`   地址: ${serverConfig.endpoint || serverConfig.command}`));

        const session = await client.connect(serverConfig);

        console.log(chalk.green('✅ 连接成功'));
        console.log(chalk.gray(`   会话 ID: ${session.id}`));
        if (session.serverInfo) {
          console.log(
            chalk.gray(`   服务器信息: ${session.serverInfo.name} v${session.serverInfo.version}`)
          );
        }

        if (options.interactive) {
          await runInteractiveClient(client, session.id);
        } else {
          // 显示基本信息
          await showServerInfo(client, session.id);
        }

        await client.disconnect(session.id);
        console.log(chalk.yellow('🔌 连接已断开'));
      } catch (error) {
        console.error(chalk.red('❌ 连接失败:'), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  clientCmd
    .command('list')
    .description('列出已配置的服务器')
    .action(() => {
      const servers = mcpConfig.getServers();
      const serverNames = Object.keys(servers);

      if (serverNames.length === 0) {
        console.log(chalk.yellow('📭 暂无配置的 MCP 服务器'));
        console.log(chalk.gray('   使用 "blade mcp config add" 添加服务器配置'));
        return;
      }

      console.log(chalk.blue('📋 已配置的 MCP 服务器:'));
      console.log('');

      serverNames.forEach(name => {
        const config = servers[name];
        console.log(chalk.green(`🔗 ${name}`));
        console.log(chalk.gray(`   传输: ${config.transport}`));
        if (config.endpoint) {
          console.log(chalk.gray(`   地址: ${config.endpoint}`));
        }
        if (config.command) {
          console.log(chalk.gray(`   命令: ${config.command} ${config.args?.join(' ') || ''}`));
        }
        console.log('');
      });
    });

  // MCP 配置命令
  const configCmd = mcpCmd.command('config').description('MCP 配置管理');

  configCmd
    .command('add')
    .description('添加 MCP 服务器配置')
    .action(async () => {
      try {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: '服务器名称:',
            validate: input => (input.trim() ? true : '请输入服务器名称'),
          },
          {
            type: 'list',
            name: 'transport',
            message: '传输方式:',
            choices: [
              { name: 'WebSocket (ws)', value: 'ws' },
              { name: 'Standard I/O (stdio)', value: 'stdio' },
            ],
          },
        ]);

        let config: MCPConnectionConfig = {
          name: answers.name,
          transport: answers.transport,
        };

        if (answers.transport === 'ws') {
          const wsAnswers = await inquirer.prompt([
            {
              type: 'input',
              name: 'endpoint',
              message: 'WebSocket 地址:',
              default: 'ws://localhost:3001',
              validate: input => (input.trim() ? true : '请输入 WebSocket 地址'),
            },
            {
              type: 'number',
              name: 'timeout',
              message: '连接超时 (毫秒):',
              default: 10000,
            },
          ]);
          config = { ...config, ...wsAnswers };
        } else {
          const stdioAnswers = await inquirer.prompt([
            {
              type: 'input',
              name: 'command',
              message: '启动命令:',
              validate: input => (input.trim() ? true : '请输入启动命令'),
            },
            {
              type: 'input',
              name: 'args',
              message: '命令参数 (用空格分隔):',
              filter: input => (input.trim() ? input.split(/\s+/) : []),
            },
          ]);
          config = { ...config, ...stdioAnswers };
        }

        const errors = mcpConfig.validateServerConfig(config);
        if (errors.length > 0) {
          console.error(chalk.red('❌ 配置验证失败:'));
          errors.forEach(error => console.error(chalk.red(`   • ${error}`)));
          return;
        }

        mcpConfig.addServer(config.name, config);
        console.log(chalk.green(`✅ 已添加服务器配置: ${config.name}`));
      } catch (error) {
        console.error(
          chalk.red('❌ 添加配置失败:'),
          error instanceof Error ? error.message : error
        );
      }
    });

  configCmd
    .command('remove <name>')
    .description('移除 MCP 服务器配置')
    .action(async name => {
      try {
        const servers = mcpConfig.getServers();
        if (!servers[name]) {
          console.error(chalk.red(`❌ 未找到服务器配置: ${name}`));
          return;
        }

        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `确定要移除服务器配置 "${name}" 吗?`,
            default: false,
          },
        ]);

        if (confirm) {
          mcpConfig.removeServer(name);
          console.log(chalk.green(`✅ 已移除服务器配置: ${name}`));
        } else {
          console.log(chalk.yellow('❌ 操作已取消'));
        }
      } catch (error) {
        console.error(
          chalk.red('❌ 移除配置失败:'),
          error instanceof Error ? error.message : error
        );
      }
    });

  configCmd
    .command('show')
    .description('显示 MCP 配置')
    .action(() => {
      const config = mcpConfig.exportConfig();
      console.log(chalk.blue('📋 MCP 配置:'));
      console.log('');
      console.log(JSON.stringify(config, null, 2));
    });

  configCmd
    .command('reset')
    .description('重置 MCP 配置为默认值')
    .action(async () => {
      try {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: '确定要重置所有 MCP 配置吗? 这将删除所有服务器配置!',
            default: false,
          },
        ]);

        if (confirm) {
          mcpConfig.reset();
          console.log(chalk.green('✅ MCP 配置已重置为默认值'));
        } else {
          console.log(chalk.yellow('❌ 操作已取消'));
        }
      } catch (error) {
        console.error(
          chalk.red('❌ 重置配置失败:'),
          error instanceof Error ? error.message : error
        );
      }
    });
}

/**
 * 运行交互式客户端
 */
async function runInteractiveClient(client: MCPClient, sessionId: string): Promise<void> {
  console.log(chalk.blue('\n🎮 进入交互式模式 (输入 "exit" 退出)'));
  console.log('');

  while (true) {
    try {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: '选择操作:',
          choices: [
            { name: '📋 列出资源', value: 'list-resources' },
            { name: '📖 读取资源', value: 'read-resource' },
            { name: '🔧 列出工具', value: 'list-tools' },
            { name: '⚡ 调用工具', value: 'call-tool' },
            { name: '🚪 退出', value: 'exit' },
          ],
        },
      ]);

      if (action === 'exit') {
        break;
      }

      switch (action) {
        case 'list-resources':
          await listResources(client, sessionId);
          break;
        case 'read-resource':
          await readResource(client, sessionId);
          break;
        case 'list-tools':
          await listTools(client, sessionId);
          break;
        case 'call-tool':
          await callTool(client, sessionId);
          break;
      }

      console.log('');
    } catch (error) {
      console.error(chalk.red('❌ 操作失败:'), error instanceof Error ? error.message : error);
    }
  }
}

/**
 * 显示服务器信息
 */
async function showServerInfo(client: MCPClient, sessionId: string): Promise<void> {
  try {
    console.log(chalk.blue('\n📋 服务器信息:'));

    // 列出资源
    const resources = await client.listResources(sessionId);
    console.log(chalk.green(`📁 可用资源 (${resources.length}):`));
    resources.forEach(resource => {
      console.log(chalk.gray(`   • ${resource.name}: ${resource.description || resource.uri}`));
    });

    // 列出工具
    const tools = await client.listTools(sessionId);
    console.log(chalk.green(`🔧 可用工具 (${tools.length}):`));
    tools.forEach(tool => {
      console.log(chalk.gray(`   • ${tool.name}: ${tool.description}`));
    });
  } catch (error) {
    console.error(
      chalk.red('❌ 获取服务器信息失败:'),
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * 列出资源
 */
async function listResources(client: MCPClient, sessionId: string): Promise<void> {
  try {
    const resources = await client.listResources(sessionId);

    if (resources.length === 0) {
      console.log(chalk.yellow('📭 没有可用的资源'));
      return;
    }

    console.log(chalk.blue(`📁 可用资源 (${resources.length}):`));
    resources.forEach((resource, index) => {
      console.log(chalk.green(`${index + 1}. ${resource.name}`));
      console.log(chalk.gray(`   URI: ${resource.uri}`));
      if (resource.description) {
        console.log(chalk.gray(`   描述: ${resource.description}`));
      }
      if (resource.mimeType) {
        console.log(chalk.gray(`   类型: ${resource.mimeType}`));
      }
      console.log('');
    });
  } catch (error) {
    console.error(
      chalk.red('❌ 获取资源列表失败:'),
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * 读取资源
 */
async function readResource(client: MCPClient, sessionId: string): Promise<void> {
  try {
    const resources = await client.listResources(sessionId);

    if (resources.length === 0) {
      console.log(chalk.yellow('📭 没有可用的资源'));
      return;
    }

    const { selectedResource } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedResource',
        message: '选择要读取的资源:',
        choices: resources.map(resource => ({
          name: `${resource.name} (${resource.uri})`,
          value: resource.uri,
        })),
      },
    ]);

    const content = await client.readResource(sessionId, selectedResource);

    console.log(chalk.blue(`📖 资源内容 (${content.mimeType}):`));
    console.log('');
    console.log(content.text || content.blob || '[二进制内容]');
  } catch (error) {
    console.error(chalk.red('❌ 读取资源失败:'), error instanceof Error ? error.message : error);
  }
}

/**
 * 列出工具
 */
async function listTools(client: MCPClient, sessionId: string): Promise<void> {
  try {
    const tools = await client.listTools(sessionId);

    if (tools.length === 0) {
      console.log(chalk.yellow('🔧 没有可用的工具'));
      return;
    }

    console.log(chalk.blue(`🔧 可用工具 (${tools.length}):`));
    tools.forEach((tool, index) => {
      console.log(chalk.green(`${index + 1}. ${tool.name}`));
      console.log(chalk.gray(`   描述: ${tool.description}`));

      const properties = tool.inputSchema.properties;
      if (properties && Object.keys(properties).length > 0) {
        console.log(chalk.gray('   参数:'));
        Object.entries(properties).forEach(([key, value]: [string, any]) => {
          const required = tool.inputSchema.required?.includes(key) ? ' (必需)' : '';
          console.log(chalk.gray(`     • ${key}${required}: ${value.description || value.type}`));
        });
      }
      console.log('');
    });
  } catch (error) {
    console.error(
      chalk.red('❌ 获取工具列表失败:'),
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * 调用工具
 */
async function callTool(client: MCPClient, sessionId: string): Promise<void> {
  try {
    const tools = await client.listTools(sessionId);

    if (tools.length === 0) {
      console.log(chalk.yellow('🔧 没有可用的工具'));
      return;
    }

    const { selectedTool } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedTool',
        message: '选择要调用的工具:',
        choices: tools.map(tool => ({
          name: `${tool.name} - ${tool.description}`,
          value: tool.name,
        })),
      },
    ]);

    const tool = tools.find(t => t.name === selectedTool)!;
    const toolArgs: Record<string, any> = {};

    // 收集工具参数
    const properties = tool.inputSchema.properties;
    if (properties && Object.keys(properties).length > 0) {
      console.log(chalk.blue('📝 请输入工具参数:'));

      for (const [key, schema] of Object.entries(properties)) {
        const isRequired = tool.inputSchema.required?.includes(key);
        const { value } = await inquirer.prompt([
          {
            type: 'input',
            name: 'value',
            message: `${key}${isRequired ? ' (必需)' : ''}:`,
            validate: input => {
              if (isRequired && !input.trim()) {
                return `${key} 是必需参数`;
              }
              return true;
            },
          },
        ]);

        if (value.trim()) {
          toolArgs[key] = value;
        }
      }
    }

    console.log(chalk.blue('⚡ 调用工具...'));
    const result = await client.callTool(sessionId, {
      name: selectedTool,
      arguments: toolArgs,
    });

    console.log(chalk.green('✅ 工具调用成功:'));
    console.log('');
    result.content.forEach(content => {
      if (content.type === 'text') {
        console.log(content.text);
      } else {
        console.log(chalk.gray(`[${content.type}内容]`));
      }
    });

    if (result.isError) {
      console.log(chalk.red('⚠️  工具执行出现错误'));
    }
  } catch (error) {
    console.error(chalk.red('❌ 调用工具失败:'), error instanceof Error ? error.message : error);
  }
}
