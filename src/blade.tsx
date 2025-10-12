/**
 * Blade Code CLI
 */

import { render } from 'ink';
import React from 'react';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { cliConfig, globalOptions } from './cli/config.js';
import {
  loadConfiguration,
  setupLogging,
  validateOutput,
  validatePermissions,
} from './cli/middleware/index.js';
// 导入命令处理器
import { configCommands } from './commands/config.js';
import { doctorCommands } from './commands/doctor.js';
import { installCommands } from './commands/install.js';
import { mcpCommands } from './commands/mcp.js';
import { handlePrintMode } from './commands/print.js';
import { setupTokenCommands } from './commands/setupToken.js';
import { updateCommands } from './commands/update.js';
import { AppWrapper as BladeApp } from './ui/App.js';

export async function main() {
  // 首先检查是否是 print 模式
  if (await handlePrintMode()) {
    return;
  }

  const cli = yargs(hideBin(process.argv))
    .scriptName(cliConfig.scriptName)
    .usage(cliConfig.usage)
    .version(cliConfig.version)
    .locale(cliConfig.locale)
    .showHelpOnFail(cliConfig.showHelpOnFail)
    .demandCommand(0, '')
    .recommendCommands()
    .strict(cliConfig.strict)

    // 应用全局选项
    .options(globalOptions)

    // 应用中间件
    .middleware([validatePermissions, loadConfiguration, setupLogging, validateOutput])

    // 注册命令
    .command(configCommands)
    .command(mcpCommands)
    .command(doctorCommands)
    .command(updateCommands)
    .command(installCommands)
    .command(setupTokenCommands)

    // 自动生成补全
    .completion('completion', 'Generate completion script for bash/zsh')

    // 帮助和版本
    .help('help', 'Show help')
    .alias('help', 'h')
    .alias('version', 'V')

    // 错误处理
    .fail((msg, err, yargs) => {
      if (err) {
        console.error('💥 An error occurred:');
        console.error(err.message);
        if (process.env.BLADE_DEBUG) {
          console.error('\nStack trace:');
          console.error(err.stack);
        }
        process.exit(1);
      }

      if (msg) {
        console.error('❌ Invalid arguments:');
        console.error(msg);
        console.error('\n💡 Did you mean:');
        yargs.showHelp();
        process.exit(1);
      }
    })

    // 处理默认行为（无命令时启动UI）
    .command(
      '$0 [message..]',
      'Start interactive AI assistant',
      (yargs) => {
        return yargs.positional('message', {
          describe: 'Initial message to send to the AI',
          type: 'string',
          array: true,
        });
      },
      async (argv) => {
        // 启动 UI 模式
        const options = { ...argv };
        const initialMessage = argv.message ? argv.message.join(' ') : undefined;

        // 启动 React UI
        const appProps: any = {
          initialMessage,
          ...(options.debug !== undefined && { debug: options.debug }),
          ...(options.verbose !== undefined && { verbose: Boolean(options.verbose) }),
          ...(options.print !== undefined && { print: Boolean(options.print) }),
        };

        const { unmount } = render(React.createElement(BladeApp, appProps), {
          patchConsole: true,
          exitOnCtrlC: false,
        });

        // 处理退出信号
        const cleanup = () => {
          unmount();
          process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
      }
    );

  // 解析参数并执行
  try {
    await cli.parse();
  } catch (error) {
    console.error('Parse error:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则启动 CLI
if (import.meta.main) {
  main().catch(console.error);
}
