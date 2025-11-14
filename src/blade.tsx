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
  validateOutput,
  validatePermissions,
} from './cli/middleware.js';
// 导入命令处理器
import { configCommands } from './commands/config.js';
import { doctorCommands } from './commands/doctor.js';
import { installCommands } from './commands/install.js';
import { mcpCommands } from './commands/mcp.js';
import { handlePrintMode } from './commands/print.js';
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
    .parserConfiguration({ 'populate--': true })

    // 应用全局选项
    .options(globalOptions)

    // 应用中间件
    .middleware([validatePermissions, loadConfiguration, validateOutput])

    // 注册命令
    .command(configCommands)
    .command(mcpCommands)
    .command(doctorCommands)
    .command(updateCommands)
    .command(installCommands)

    // 自动生成补全（隐藏，避免干扰普通用户）
    .completion('completion', false)

    // 帮助和版本
    .help('help', 'Show help')
    .alias('help', 'h')
    .alias('version', 'V')

    // 错误处理
    .fail((msg, err, yargs) => {
      if (err) {
        console.error('💥 An error occurred:');
        console.error(err.message);
        // 总是显示堆栈信息（用于调试）
        console.error('\nStack trace:');
        console.error(err.stack);
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
      '$0',
      false, // 隐藏此命令，不在 help 中显示
      () => {
        // 不定义 positional，避免在 --help 中显示 Positionals 部分
      },
      async (argv) => {
        // 启动 UI 模式
        // 从 argv._ 中获取额外的参数作为 initialMessage
        const nonOptionArgs = (argv._ as string[]).slice(1); // 跳过命令名
        const initialMessage = nonOptionArgs.length > 0 ? nonOptionArgs.join(' ') : undefined;

        // 启动 React UI - 传递所有选项
        const appProps: any = {
          ...argv,
          initialMessage,
          // 确保某些字段是正确的类型
          debug: argv.debug,
          print: Boolean(argv.print),
        };

        // 移除内部字段
        delete appProps._;
        delete appProps.$0;
        delete appProps.message;

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
