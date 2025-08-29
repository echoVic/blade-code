import chalk from 'chalk';
import { Command } from 'commander';
import { Agent } from '../agent/Agent.js';

/**
 * 注册 LLM 相关命令
 */
export function llmCommand(program: Command) {
  // LLM 直接聊天命令
  program
    .command('llm')
    .description('🤖 纯 LLM 模式聊天')
    .argument('[message...]', '要发送的消息')
    .option('-k, --api-key <key>', 'API 密钥')
    .option('-u, --base-url <url>', 'API 基础 URL')
    .option('-m, --model <model>', '模型名称')
    .option('--stream', '启用流式输出', false)
    .action(async (messageArgs, options) => {
      try {
        // 构建配置
        const config: any = {};
        if (options.apiKey) config.apiKey = options.apiKey;
        if (options.baseUrl) config.baseUrl = options.baseUrl;
        if (options.model) config.modelName = options.model;

        // 创建 Agent 实例
        const agent = new Agent(config);

        const message = messageArgs.join(' ');

        if (!message) {
          console.log(chalk.red('❌ 请输入要发送的消息'));
          return;
        }

        if (options.stream) {
          console.log(chalk.green('🤖 AI: '), { newline: false });
          // 流式输出实现
          console.log('流式输出功能开发中...');
        } else {
          const response = await agent.chat(message);
          console.log(chalk.green(`🤖 AI: ${response}`));
        }
      } catch (error) {
        console.error(chalk.red('❌ LLM 调用失败:'), error);
      }
    });
}
