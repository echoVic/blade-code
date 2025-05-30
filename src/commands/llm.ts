import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { getProviderConfig, isProviderSupported } from '../config/defaults.js';
import { BaseLLM } from '../llm/BaseLLM.js';
import { QwenLLM } from '../llm/QwenLLM.js';
import { VolcEngineLLM } from '../llm/VolcEngineLLM.js';

/**
 * 注册 LLM 相关命令
 */
export function llmCommand(program: Command) {
  // LLM 直接聊天命令
  program
    .command('llm')
    .alias('l')
    .description('💬 LLM 直接聊天模式')
    .option('-p, --provider <provider>', '选择 LLM 提供商 (volcengine|qwen)', 'qwen')
    .option('-k, --api-key <key>', 'API 密钥')
    .option('-m, --model <model>', '指定模型')
    .option('-s, --stream', '启用流式输出', false)
    .action(async options => {
      try {
        if (!isProviderSupported(options.provider)) {
          console.log(chalk.red(`❌ 不支持的提供商: ${options.provider}`));
          console.log(chalk.gray('支持的提供商: qwen, volcengine'));
          return;
        }

        // 验证API密钥
        let apiKey: string;
        try {
          const { validateApiKey } = await import('../config/defaults.js');
          apiKey = validateApiKey(options.provider, options.apiKey);
        } catch (error) {
          console.log(chalk.red('\n❌ API密钥配置错误'));
          console.log(chalk.yellow('\n💡 配置API密钥的方法:'));
          console.log(chalk.gray('1. 命令行参数: --api-key your-api-key'));
          console.log(
            chalk.gray(
              '2. 环境变量: export QWEN_API_KEY=your-key 或 export VOLCENGINE_API_KEY=your-key'
            )
          );
          console.log(chalk.gray('3. .env 文件: 复制 config.env.example 为 .env 并填入密钥'));
          console.log(chalk.gray('\n📖 获取API密钥:'));
          if (options.provider === 'qwen') {
            console.log(chalk.gray('千问: https://dashscope.console.aliyun.com/apiKey'));
          } else if (options.provider === 'volcengine') {
            console.log(
              chalk.gray(
                '火山引擎: https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
              )
            );
          }
          return;
        }

        const providerConfig = getProviderConfig(options.provider);
        const model = options.model || providerConfig.defaultModel;

        console.log(chalk.blue(`\n🤖 启动 ${options.provider.toUpperCase()} LLM 聊天`));
        console.log(chalk.green(`📱 模型: ${model}`));
        console.log(chalk.gray('💡 输入 "quit" 或 "exit" 退出聊天\n'));

        // 创建LLM实例
        let llm: QwenLLM | VolcEngineLLM;
        if (options.provider === 'qwen') {
          llm = new QwenLLM({ apiKey, baseURL: providerConfig.baseURL }, model);
        } else {
          llm = new VolcEngineLLM({ apiKey, baseURL: providerConfig.baseURL }, model);
        }

        await llm.init();
        console.log(chalk.green(`✅ 已连接 ${options.provider} (${model})`));

        // 开始聊天循环
        await startChatLoop(llm, options.stream);
      } catch (error) {
        console.error(chalk.red('❌ LLM 聊天失败:'), error);
      }
    });

  // 模型列表命令
  program
    .command('models')
    .alias('m')
    .description('📋 查看可用模型列表')
    .option('-p, --provider <provider>', '选择 LLM 提供商 (volcengine|qwen)', 'qwen')
    .action(async options => {
      try {
        if (!isProviderSupported(options.provider)) {
          console.log(chalk.red(`❌ 不支持的提供商: ${options.provider}`));
          return;
        }

        const providerConfig = getProviderConfig(options.provider);
        console.log(chalk.blue(`\n🤖 ${options.provider.toUpperCase()} 可用模型:`));
        console.log(chalk.green(`默认模型: ${providerConfig.defaultModel}`));
        console.log(chalk.gray('\n支持的模型:'));

        providerConfig.supportedModels.forEach((model, index) => {
          const isDefault = model === providerConfig.defaultModel;
          const prefix = isDefault ? chalk.yellow('* ') : '  ';
          console.log(`${prefix}${index + 1}. ${model}`);
        });

        console.log(chalk.gray('\n* 表示默认模型'));
      } catch (error) {
        console.error(chalk.red('❌ 获取模型列表失败:'), error);
      }
    });
}

/**
 * 开始聊天循环
 */
async function startChatLoop(llm: BaseLLM, useStream: boolean = false) {
  console.log(chalk.cyan('\n🤖 LLM 聊天开始！输入 "quit" 或 "exit" 退出'));
  console.log(chalk.gray('支持多行输入，按两次回车发送消息\n'));

  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  while (true) {
    try {
      // 获取用户输入
      const answers = await inquirer.prompt([
        {
          type: 'editor',
          name: 'message',
          message: '你:',
          postfix: '.md',
        },
      ]);

      const userMessage = answers.message.trim();

      if (!userMessage) {
        console.log(chalk.yellow('请输入有效的消息'));
        continue;
      }

      if (userMessage.toLowerCase() === 'quit' || userMessage.toLowerCase() === 'exit') {
        console.log(chalk.blue('👋 再见！'));
        break;
      }

      // 添加用户消息到历史
      conversationHistory.push({ role: 'user', content: userMessage });

      // 生成回复
      console.log(chalk.green('\nAI: '), { newline: false });

      if (useStream && llm instanceof QwenLLM && llm.streamChat) {
        // 流式输出
        const response = await llm.streamChat(
          {
            messages: conversationHistory,
          },
          chunk => {
            process.stdout.write(chunk);
          }
        );

        console.log('\n');
        conversationHistory.push({ role: 'assistant', content: response.content });
      } else {
        // 普通输出
        const response = await llm.conversation(conversationHistory);
        console.log(response);
        console.log('');

        conversationHistory.push({ role: 'assistant', content: response });
      }

      // 保持对话历史在合理长度
      if (conversationHistory.length > 20) {
        conversationHistory.splice(0, 2);
      }
    } catch (error) {
      console.error(chalk.red('❌ 聊天错误:'), error);
    }
  }

  await llm.destroy();
}
