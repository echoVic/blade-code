import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Client, Server } from '@modelcontextprotocol/sdk';
import { ToolManager } from '@blade-ai/core';
import { UIDisplay, UIInput, UILayout, UIList, UIProgress } from '../ui/index.js';

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
      let spinner = UIProgress.spinner('正在初始化服务器配置...');
      spinner.start();

      try {
        const serverConfig = mcpConfig.getServerConfig();
        const config = {
          port: parseInt(options.port) || serverConfig.port,
          host: options.host || serverConfig.host,
          transport: options.transport || serverConfig.transport,
          auth: serverConfig.auth,
        };

        spinner.succeed('配置初始化完成');

        spinner = UIProgress.spinner('正在启动工具管理器...');
        spinner.start();

        const toolManager = await createToolManager();

        spinner.succeed('工具管理器启动完成');

        UILayout.card(
          'MCP 服务器配置',
          [
            `传输方式: ${config.transport}`,
            config.transport === 'ws' ? `监听地址: ws://${config.host}:${config.port}` : null,
          ].filter(Boolean) as string[],
          { icon: '🚀' }
        );

        spinner = UIProgress.spinner('正在启动 MCP 服务器...');
        spinner.start();

        const server = new Server(config, toolManager);
        await server.start();

        server.on('started', info => {
          spinner.succeed('MCP 服务器启动成功');

          if (info.host && info.port) {
            UIDisplay.success(`服务器地址: ws://${info.host}:${info.port}`);
          }
          UIDisplay.info('按 Ctrl+C 停止服务器');
        });

        server.on('error', error => {
          UIDisplay.error(`服务器错误: ${error.message}`);
        });

        // 处理退出信号
        process.on('SIGINT', async () => {
          const exitSpinner = UIProgress.spinner('正在停止服务器...');
          exitSpinner.start();

          await server.stop();
          exitSpinner.succeed('服务器已停止');
          process.exit(0);
        });
      } catch (error) {
        if (spinner) spinner.fail('服务器启动失败');
        UIDisplay.error(`错误: ${error instanceof Error ? error.message : error}`);
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
      let spinner = UIProgress.spinner('正在验证服务器配置...');
      spinner.start();

      try {
        const serverConfig = mcpConfig.getServer(serverName);
        if (!serverConfig) {
          spinner.fail('服务器配置不存在');
          UIDisplay.error(`未找到服务器配置: ${serverName}`);
          UIDisplay.info('使用 "blade mcp config add" 添加服务器配置');
          return;
        }

        spinner.succeed('服务器配置验证完成');

        UILayout.card(
          '连接信息',
          [
            `服务器: ${serverName}`,
            `地址: ${serverConfig.endpoint || serverConfig.command}`,
            `传输方式: ${serverConfig.transport}`,
          ],
          { icon: '🔗' }
        );

        spinner = UIProgress.spinner('正在连接到 MCP 服务器...');
        spinner.start();

        const client = new Client();
        const session = await client.connect(serverConfig);

        spinner.succeed('连接成功');

        UILayout.card(
          '会话信息',
          [
            `会话 ID: ${session.id}`,
            session.serverInfo
              ? `服务器: ${session.serverInfo.name} v${session.serverInfo.version}`
              : null,
          ].filter(Boolean) as string[],
          { icon: '✅' }
        );

        if (options.interactive) {
          await runInteractiveClient(client, session.id);
        } else {
          // 显示基本信息
          await showServerInfo(client, session.id);
        }

        const disconnectSpinner = UIProgress.spinner('正在断开连接...');
        disconnectSpinner.start();

        await client.disconnect(session.id);
        disconnectSpinner.succeed('连接已断开');
      } catch (error) {
        if (spinner) spinner.fail('连接失败');
        UIDisplay.error(`错误: ${error instanceof Error ? error.message : error}`);
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
        UIDisplay.warning('暂无配置的 MCP 服务器');
        UIDisplay.info('使用 "blade mcp config add" 添加服务器配置');
        return;
      }

      UIDisplay.section('已配置的 MCP 服务器');

      const serverList = serverNames.map(name => {
        const config = servers[name];
        let info = `${name} (${config.transport})`;

        if (config.endpoint) {
          info += ` - ${config.endpoint}`;
        } else if (config.command) {
          info += ` - ${config.command}`;
        }

        return info;
      });

      UIList.simple(serverList);
      UIDisplay.info(`共 ${serverNames.length} 个服务器`);
    });

  // MCP 配置命令
  const configCmd = mcpCmd.command('config').description('MCP 配置管理');

  configCmd
    .command('add')
    .description('添加 MCP 服务器配置')
    .action(async () => {
      try {
        UIDisplay.header('添加 MCP 服务器配置');

        const name = await UIInput.text('服务器名称:', {
          validate: input => (input.trim() ? true : '请输入服务器名称'),
        });

        const transport = await UIInput.select('传输方式:', [
          { name: 'WebSocket (ws)', value: 'ws' },
          { name: 'Standard I/O (stdio)', value: 'stdio' },
        ]);

        let config: MCPConnectionConfig = {
          name,
          transport: transport as 'ws' | 'stdio',
        };

        if (transport === 'ws') {
          const endpoint = await UIInput.text('WebSocket 地址:', {
            default: 'ws://localhost:3001',
            validate: input => (input.trim() ? true : '请输入 WebSocket 地址'),
          });

          const timeout = await UIInput.text('连接超时 (毫秒):', {
            default: '10000',
            validate: input => (!isNaN(Number(input)) ? true : '请输入有效数字'),
          });

          config = {
            ...config,
            endpoint,
            timeout: parseInt(timeout),
          };
        } else {
          const command = await UIInput.text('执行命令:', {
            validate: input => (input.trim() ? true : '请输入执行命令'),
          });

          const args = await UIInput.text('命令参数 (可选):', { default: '' });

          config = {
            ...config,
            command,
            args: args ? args.split(' ') : undefined,
          };
        }

        const spinner = UIProgress.spinner('正在保存配置...');
        spinner.start();

        mcpConfig.addServer(name, config);

        spinner.succeed('服务器配置添加成功');

        UILayout.card(
          '配置详情',
          [
            `名称: ${config.name}`,
            `传输方式: ${config.transport}`,
            config.endpoint ? `地址: ${config.endpoint}` : null,
            config.command ? `命令: ${config.command}` : null,
          ].filter(Boolean) as string[],
          { icon: '✅' }
        );
      } catch (error: any) {
        UIDisplay.error(`配置添加失败: ${error.message}`);
      }
    });

  configCmd
    .command('remove <name>')
    .description('删除服务器配置')
    .action(async name => {
      try {
        const servers = mcpConfig.getServers();
        if (!servers[name]) {
          UIDisplay.error(`服务器配置 "${name}" 不存在`);
          return;
        }

        UILayout.card('将要删除的配置', [`名称: ${name}`, `传输方式: ${servers[name].transport}`], {
          icon: '⚠️',
        });

        const confirmed = await UIInput.confirm('确认删除此配置？', { default: false });

        if (!confirmed) {
          UIDisplay.info('操作已取消');
          return;
        }

        const spinner = UIProgress.spinner('正在删除配置...');
        spinner.start();

        mcpConfig.removeServer(name);

        spinner.succeed(`服务器配置 "${name}" 已删除`);
      } catch (error: any) {
        UIDisplay.error(`删除配置失败: ${error.message}`);
      }
    });

  configCmd
    .command('show [name]')
    .description('显示服务器配置')
    .action(name => {
      try {
        if (name) {
          const config = mcpConfig.getServer(name);
          if (!config) {
            UIDisplay.error(`服务器配置 "${name}" 不存在`);
            return;
          }

          UILayout.card(
            `服务器配置: ${name}`,
            [
              `传输方式: ${config.transport}`,
              config.endpoint ? `地址: ${config.endpoint}` : null,
              config.command ? `命令: ${config.command}` : null,
              config.args?.length ? `参数: ${config.args.join(' ')}` : null,
              config.timeout ? `超时: ${config.timeout}ms` : null,
            ].filter(Boolean) as string[],
            { icon: '📋' }
          );
        } else {
          const servers = mcpConfig.getServers();
          const serverNames = Object.keys(servers);

          if (serverNames.length === 0) {
            UIDisplay.warning('暂无配置的服务器');
            return;
          }

          UIDisplay.section('所有服务器配置');

          serverNames.forEach(serverName => {
            const config = servers[serverName];
            UILayout.card(
              serverName,
              [
                `传输方式: ${config.transport}`,
                config.endpoint ? `地址: ${config.endpoint}` : null,
                config.command ? `命令: ${config.command}` : null,
              ].filter(Boolean) as string[]
            );
            UIDisplay.newline();
          });
        }
      } catch (error: any) {
        UIDisplay.error(`获取配置失败: ${error.message}`);
      }
    });
}

/**
 * 运行交互式客户端
 */
async function runInteractiveClient(client: Client, sessionId: string): Promise<void> {
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
async function showServerInfo(client: Client, sessionId: string): Promise<void> {
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
async function listResources(client: Client, sessionId: string): Promise<void> {
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
async function readResource(client: Client, sessionId: string): Promise<void> {
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
async function listTools(client: Client, sessionId: string): Promise<void> {
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
async function callTool(client: Client, sessionId: string): Promise<void> {
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

      for (const [key] of Object.entries(properties)) {
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
