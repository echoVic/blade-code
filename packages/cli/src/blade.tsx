
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';

// 引入重构后的 App.tsx 作为主 UI 入口点
import { AppWrapper as BladeApp } from './ui/App.js';

// --- Command Definitions ---
import { agentLlmCommand } from './commands/agent-llm.js';
import { configCommand } from './commands/config.js';
import { llmCommand } from './commands/llm.js';
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
  llmCommand(program);
  mcpCommand(program);
  toolsCommand(program);

  // 设置默认动作：如果没有提供子命令，则启动交互式UI
  program.action((options) => {
    render(React.createElement(BladeApp, { 
      debug: options.debug,
      testMode: options.test 
    }));
  });

  await program.parseAsync(process.argv);

  // 如果解析后没有匹配到任何已知命令（除了默认的 help, version），则也启动交互式UI
  // commander 在没有匹配到命令时，args 数组会是空的
  if (program.args.length === 0) {
     render(React.createElement(BladeApp, { 
       debug: program.opts().debug,
       testMode: program.opts().test 
     }));
  }
}
