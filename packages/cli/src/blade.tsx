
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';

// 引入重构后的 App.tsx 作为主 UI 入口点
import { AppWrapper as BladeApp } from './ui/App.js';

// --- Command Definitions ---
import { agentLlmCommand } from './commands/agent-llm.js';
import { configCommand } from './commands/config.js';
import { mcpCommand } from './commands/mcp.js';
import { toolsCommand } from './commands/tools.js';

export async function main() {
  const program = new Command();

  program
    .version('1.3.0', '-v, --version', '显示当前版本')
    .description('Blade AI - 智能AI助手命令行界面')
    .option('-d, --debug', '启用调试模式')
    .option('-t, --test', '启用测试模式');

  // 注册所有命令
  agentLlmCommand(program);
  configCommand(program);
  mcpCommand(program);
  toolsCommand(program);

  // 检查是否提供了有效的子命令
  const args = process.argv.slice(2);
  const hasValidCommand = args.length > 0 && 
    (args.includes('chat') || args.includes('c') || 
     args.includes('config') || args.includes('llm') || 
     args.includes('mcp') || args.includes('tools') ||
     args.includes('help') || args.includes('-h') || 
     args.includes('--help') || args.includes('-v') || 
     args.includes('--version'));

  if (!hasValidCommand) {
    // 没有提供命令，启动交互式UI
    const { unmount } = render(React.createElement(BladeApp, { 
      debug: args.includes('-d') || args.includes('--debug'),
      testMode: args.includes('-t') || args.includes('--test')
    }));
    
    // 保持应用运行，直到用户退出
    process.on('SIGINT', () => {
      unmount();
      process.exit(0);
    });
  } else {
    // 有命令，正常解析
    await program.parseAsync(process.argv);
  }
}
