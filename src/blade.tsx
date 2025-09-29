import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
// 引入命令模块
import {
  configCommand,
  doctorCommand,
  installCommand,
  mcpCommand,
  setupTokenCommand,
  updateCommand,
} from './commands/index.js';
import { handlePrintMode } from './commands/print.js';
// 引入重构后的 App.tsx 作为主 UI 入口点
import { AppWrapper as BladeApp } from './ui/App.js';

export async function main() {
  // 首先检查是否是 print 模式
  if (await handlePrintMode()) {
    return;
  }

  const program = new Command();

  // Claude Code 风格的基础配置
  program
    .name('blade')
    .version('1.3.0')
    .description('🗡️ Blade AI - 智能AI助手命令行界面')
    .allowUnknownOption(true) // 允许未知选项，这样 --print 后面的参数不会报错
    .helpOption('-h, --help', 'display help for command')
    .addHelpCommand(false) // 禁用默认的 help 命令
    .action(() => {
      // 默认action什么都不做，阻止显示help
    })
    .option(
      '-d, --debug [filter]',
      'Enable debug mode with optional category filtering'
    )
    .option('--verbose', 'Override verbose mode setting from config')
    .option('-p, --print', 'Print response and exit (useful for pipes)')
    .option(
      '--output-format <format>',
      'Output format (only works with --print): "text", "json", "stream-json"',
      'text'
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive'
    )
    .option('--input-format <format>', 'Input format: "text", "stream-json"', 'text')
    .option('--mcp-debug', '[DEPRECATED. Use --debug instead] Enable MCP debug mode')
    .option('--dangerously-skip-permissions', 'Bypass all permission checks')
    .option('--replay-user-messages', 'Re-emit user messages from stdin')
    .option(
      '--allowedTools, --allowed-tools <tools...>',
      'Comma or space-separated list of tool names to allow'
    )
    .option(
      '--disallowedTools, --disallowed-tools <tools...>',
      'Comma or space-separated list of tool names to deny'
    )
    .option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings')
    .option(
      '--append-system-prompt <prompt>',
      'Append a system prompt to the default system prompt'
    )
    .option(
      '--permission-mode <mode>',
      'Permission mode: "acceptEdits", "bypassPermissions", "default", "plan"'
    )
    .option('-c, --continue', 'Continue the most recent conversation')
    .option('-r, --resume [sessionId]', 'Resume a conversation')
    .option('--fork-session', 'Create a new session ID when resuming')
    .option('--model <model>', 'Model for the current session')
    .option('--fallback-model <model>', 'Enable automatic fallback to specified model')
    .option('--settings <file-or-json>', 'Path to a settings JSON file or JSON string')
    .option(
      '--add-dir <directories...>',
      'Additional directories to allow tool access to'
    )
    .option('--ide', 'Automatically connect to IDE on startup')
    .option('--strict-mcp-config', 'Only use MCP servers from --mcp-config')
    .option('--session-id <uuid>', 'Use a specific session ID for the conversation')
    .option('--agents <json>', 'JSON object defining custom agents')
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load'
    );

  // 注册所有命令
  configCommand(program);
  mcpCommand(program);
  doctorCommand(program);
  updateCommand(program);
  installCommand(program);
  setupTokenCommand(program);

  // 检查命令行参数
  const argv = process.argv.slice(2);
  const hasHelpArg = argv.includes('-h') || argv.includes('--help') || argv.includes('help');
  const hasVersionArg = argv.includes('-V') || argv.includes('--version');
  const hasSubCommand = argv.length > 0 && ['config', 'mcp', 'doctor', 'update', 'install', 'setup-token'].includes(argv[0]);

  // 如果是帮助或版本命令，使用 commander 处理
  if (hasHelpArg || hasVersionArg || hasSubCommand) {
    try {
      program.parse(process.argv);
    } catch (error) {
      console.error('Parse error:', error);
      process.exit(1);
    }
    return;
  }

  // 否则启动 UI 模式
  try {
    program.parse(process.argv);
  } catch (error) {
    console.error('Parse error:', error);
    process.exit(1);
  }
  const options = program.opts();

  // 启动 UI 模式
  // 获取剩余的参数作为初始消息
  const remainingArgs = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('-') && !Object.values(options).includes(arg));
  const initialMessage = remainingArgs.join(' ');

  // 启动 UI 模式
  const { unmount } = render(
    React.createElement(BladeApp, {
      ...options,
      initialMessage: initialMessage || undefined,
    }),
    {
      // 检查是否支持 raw mode，如果不支持则使用替代方案
      patchConsole: true,
      exitOnCtrlC: false,
    }
  );

  // 处理退出信号
  process.on('SIGINT', () => {
    unmount();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    unmount();
    process.exit(0);
  });
}

// 如果直接运行此文件，则启动 CLI
if (import.meta.main) {
  main().catch(console.error);
}
