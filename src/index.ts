import chalk from 'chalk';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';

const program = new Command();

// 设置基本信息
program
  .name('agent')
  .description('一个功能强大的 CLI 工具')
  .version('1.0.0');

// 注册命令
initCommand(program);

// 添加帮助信息
program.on('--help', () => {
  console.log('');
  console.log(chalk.green('示例:'));
  console.log('  $ agent init myproject');
});

// 解析命令行参数
program.parse(process.argv);

// 如果没有提供任何命令，显示帮助信息
if (!process.argv.slice(2).length) {
  program.outputHelp();
} 