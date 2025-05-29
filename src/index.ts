import chalk from 'chalk';
import { Command } from 'commander';
import { agentLlmCommand } from './commands/agent-llm.js';
import { llmCommand } from './commands/llm.js';

// 导出 Agent 和 LLM 相关模块
export { Agent, AgentConfig } from './agent/Agent.js';
export { BaseComponent } from './agent/BaseComponent.js';
export { LoggerComponent } from './agent/LoggerComponent.js';

// LLM 模块
export { BaseLLM } from './llm/BaseLLM.js';
export { QwenLLM } from './llm/QwenLLM.js';
export { VolcEngineLLM } from './llm/VolcEngineLLM.js';

// 配置模块
export { DEFAULT_CONFIG, getProviderConfig, getSupportedProviders, isProviderSupported, loadConfigFromEnv } from './config/defaults.js';
export type { DefaultConfig, LLMProviderConfig } from './config/defaults.js';

// 类型定义
export type {
  LLMMessage,
  LLMRequest,
  LLMResponse
} from './llm/BaseLLM.js';

const program = new Command();

// 设置基本信息
program
  .name('agent')
  .description('🤖 智能 LLM CLI Agent - 你的 AI 助手')
  .version('1.0.0');

// 注册 LLM 相关命令
agentLlmCommand(program);
llmCommand(program);

// 添加帮助信息
program.on('--help', () => {
  console.log('');
  console.log(chalk.blue('🚀 LLM CLI Agent 使用示例:'));
  console.log('');
  console.log(chalk.green('  💬 直接问答:'));
  console.log('  $ agent chat 什么是 agent');
  console.log('  $ agent chat 解释一下微服务架构');
  console.log('  $ agent chat --scenario customer 怎么退货');
  console.log('');
  console.log(chalk.green('  🔄 交互式聊天:'));
  console.log('  $ agent chat --interactive');
  console.log('  $ agent chat -i --scenario code');
  console.log('');
  console.log(chalk.green('  🎭 场景演示:'));
  console.log('  $ agent chat --demo --scenario assistant');
  console.log('  $ agent chat --demo --scenario customer');
  console.log('');
  console.log(chalk.green('  🤖 纯 LLM 模式:'));
  console.log('  $ agent llm --stream');
  console.log('  $ agent llm --provider volcengine');
  console.log('');
  console.log(chalk.green('  📋 模型管理:'));
  console.log('  $ agent models --provider qwen');
  console.log('  $ agent models --provider volcengine');
  console.log('');
  console.log(chalk.yellow('💡 提示: 直接使用 "agent chat 你的问题" 开始对话'));
});

if (!process.argv.slice(2).length) {
  console.log(chalk.cyan('🤖 欢迎使用 LLM CLI Agent！'));
  console.log('');
  program.outputHelp();
  process.exit(0);
}

// 解析命令行参数
program.parse(process.argv); 