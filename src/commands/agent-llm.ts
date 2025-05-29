import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { getProviderConfig, isProviderSupported } from '../config/defaults.js';
import { LLMMessage } from '../llm/BaseLLM.js';

/**
 * 注册智能聊天命令
 */
export function agentLlmCommand(program: Command) {
  program
    .command('chat')
    .description('🤖 智能 Agent 聊天')
    .argument('[question...]', '要问的问题（可选）')
    .option('-p, --provider <provider>', '选择 LLM 提供商 (volcengine|qwen)', 'qwen')
    .option('-k, --api-key <key>', 'API 密钥')
    .option('-m, --model <model>', '指定模型')
    .option('-s, --scenario <scenario>', '选择场景 (customer|code|assistant)', 'assistant')
    .option('-i, --interactive', '启动交互式聊天模式', false)
    .option('--demo', '运行场景演示', false)
    .action(async (questionArgs, options) => {
      console.log(chalk.blue('🤖 启动智能 Agent...'));
      
      try {
        // 验证提供商
        if (!isProviderSupported(options.provider)) {
          console.log(chalk.red(`❌ 不支持的提供商: ${options.provider}`));
          return;
        }

        // 获取配置
        const providerConfig = getProviderConfig(options.provider);
        let apiKey = options.apiKey || providerConfig.apiKey;
        
        if (!apiKey || apiKey.startsWith('sk-') && apiKey.length < 20) {
          const answers = await inquirer.prompt([
            {
              type: 'password',
              name: 'apiKey',
              message: `请输入 ${options.provider} 的 API 密钥:`,
              mask: '*'
            }
          ]);
          apiKey = answers.apiKey;
        }

        const model = options.model || providerConfig.defaultModel;

        // 创建 Agent 配置
        const agentConfig: AgentConfig = {
          debug: false, // 直接聊天时关闭调试日志
          llm: {
            provider: options.provider,
            apiKey: apiKey,
            model: model
          }
        };

        console.log(chalk.green(`✅ 使用 ${options.provider} (${model})`));

        // 判断聊天模式
        const question = questionArgs.join(' ');
        
        if (options.demo) {
          // 演示模式
          agentConfig.debug = true; // 演示时显示调试信息
          await runScenarioDemo(agentConfig, options.scenario);
        } else if (question) {
          // 单次问答模式
          await answerSingleQuestion(agentConfig, question, options.scenario);
        } else if (options.interactive) {
          // 交互式聊天模式
          await startInteractiveChat(agentConfig, options.scenario);
        } else {
          // 默认：启动交互式聊天
          await startInteractiveChat(agentConfig, options.scenario);
        }

      } catch (error) {
        console.error(chalk.red('❌ 启动失败:'), error);
      }
    });
}

/**
 * 单次问答
 */
async function answerSingleQuestion(config: AgentConfig, question: string, scenario: string) {
  const agent = new Agent(config);
  await agent.init();

  try {
    let response: string;
    
    switch (scenario) {
      case 'customer':
        const systemPrompt = `你是专业的客服代表，友好耐心地解答问题`;
        response = await agent.chatWithSystem(systemPrompt, question);
        break;
      case 'code':
        response = await agent.reviewCode(question, 'auto-detect');
        break;
      case 'assistant':
      default:
        response = await agent.ask(question);
        break;
    }

    console.log(chalk.green(`\n💬 AI: ${response}`));
    
  } catch (error) {
    console.error(chalk.red('❌ 回答失败:'), error);
  } finally {
    await agent.destroy();
  }
}

/**
 * 交互式聊天
 */
async function startInteractiveChat(config: AgentConfig, scenario: string) {
  console.log(chalk.cyan(`\n=== 🤖 ${getScenarioName(scenario)} ===`));
  console.log(chalk.gray('输入 "quit" 或 "exit" 退出聊天\n'));

  const agent = new Agent(config);
  await agent.init();

  try {
    while (true) {
      const { message } = await inquirer.prompt([
        {
          type: 'input',
          name: 'message',
          message: '你:'
        }
      ]);

      if (!message.trim()) {
        continue;
      }

      if (message.toLowerCase() === 'quit' || message.toLowerCase() === 'exit') {
        console.log(chalk.blue('👋 再见！'));
        break;
      }

      try {
        let response: string;
        
        switch (scenario) {
          case 'customer':
            const systemPrompt = `你是专业的客服代表，友好耐心地解答问题`;
            response = await agent.chatWithSystem(systemPrompt, message);
            break;
          case 'code':
            if (message.includes('```') || message.includes('function') || message.includes('class')) {
              response = await agent.reviewCode(message, 'auto-detect');
            } else {
              response = await agent.ask(`作为代码助手，${message}`);
            }
            break;
          case 'assistant':
          default:
            response = await agent.ask(message);
            break;
        }

        console.log(chalk.green(`AI: ${response}\n`));
        
      } catch (error) {
        console.error(chalk.red('❌ 聊天错误:'), error);
      }
    }
  } finally {
    await agent.destroy();
  }
}

/**
 * 运行场景演示
 */
async function runScenarioDemo(config: AgentConfig, scenario: string) {
  switch (scenario) {
    case 'customer':
      await startCustomerService(config);
      break;
    case 'code':
      await startCodeAssistant(config);
      break;
    case 'assistant':
      await startBasicAssistant(config);
      break;
    default:
      console.log(chalk.red(`❌ 不支持的场景: ${scenario}`));
      return;
  }
}

/**
 * 获取场景名称
 */
function getScenarioName(scenario: string): string {
  switch (scenario) {
    case 'customer': return '智能客服';
    case 'code': return '代码助手';
    case 'assistant': return '智能助手';
    default: return '智能助手';
  }
}

/**
 * 启动智能客服
 */
async function startCustomerService(config: AgentConfig) {
  console.log(chalk.cyan('\n=== 🎧 智能客服 Agent ==='));
  
  const agent = new Agent(config);
  await agent.init();

  const scenarios = [
    '我想了解你们的退货政策',
    '这个产品质量太差了，我要求退款！',
    '请问你们有什么优惠活动吗？'
  ];

  for (const inquiry of scenarios) {
    console.log(chalk.yellow(`\n客户: ${inquiry}`));
    
    try {
      const systemPrompt = `你是专业的客服代表，友好耐心地解答问题`;
      const response = await agent.chatWithSystem(systemPrompt, inquiry);
      console.log(chalk.green(`客服: ${response}`));

      if (inquiry.includes('质量太差')) {
        console.log(chalk.gray('\n分析客户情绪...'));
        const sentiment = await agent.analyzeSentiment(inquiry);
        console.log(chalk.blue(`情绪分析: ${sentiment}`));
      }
    } catch (error) {
      console.error(chalk.red('❌ 处理失败:'), error);
    }
  }

  await agent.destroy();
  console.log(chalk.green('\n✅ 客服演示完成'));
}

/**
 * 启动代码助手
 */
async function startCodeAssistant(config: AgentConfig) {
  console.log(chalk.cyan('\n=== 💻 代码助手 Agent ==='));
  
  const agent = new Agent(config);
  await agent.init();

  const sampleCode = `
function calculateTotal(items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}`;

  console.log(chalk.yellow('\n待分析的代码:'));
  console.log(sampleCode);

  try {
    console.log(chalk.gray('\n🔍 正在进行代码审查...'));
    const review = await agent.reviewCode(sampleCode, 'javascript');
    console.log(chalk.green('\n📋 代码审查结果:'));
    console.log(review);

    console.log(chalk.gray('\n🧪 正在生成测试用例...'));
    const prompt = `为以下代码生成测试用例：\n${sampleCode}`;
    const tests = await agent.chat(prompt);
    console.log(chalk.green('\n🔬 生成的测试用例:'));
    console.log(tests);

  } catch (error) {
    console.error(chalk.red('❌ 代码分析失败:'), error);
  }

  await agent.destroy();
  console.log(chalk.green('\n✅ 代码助手演示完成'));
}

/**
 * 启动基础助手
 */
async function startBasicAssistant(config: AgentConfig) {
  console.log(chalk.cyan('\n=== 🤖 智能助手 Agent ==='));
  
  const agent = new Agent(config);
  await agent.init();

  // 显示 Agent 状态
  const status = agent.getStatus();
  console.log(chalk.gray(`Agent 状态: LLM=${status.llmProvider}, 组件数=${status.componentCount}`));

  try {
    // 智能问答
    console.log(chalk.yellow('\n问题: 什么是微服务架构？'));
    const answer = await agent.ask('什么是微服务架构？请简洁地解释');
    console.log(chalk.green(`回答: ${answer}`));

    // 代码生成
    console.log(chalk.yellow('\n请求: 生成快速排序算法'));
    const code = await agent.generateCode('实现快速排序算法', 'python');
    console.log(chalk.green(`生成的代码:\n${code}`));

    // 流式回答
    console.log(chalk.yellow('\n流式问答: 解释区块链技术'));
    process.stdout.write(chalk.green('AI: '));
    
    const messages: LLMMessage[] = [
      { role: 'user' as const, content: '请简单解释什么是区块链技术' }
    ];
    
    await agent.streamChat(messages, (chunk) => {
      process.stdout.write(chunk);
    });
    console.log('\n');

  } catch (error) {
    console.error(chalk.red('❌ 助手操作失败:'), error);
  }

  await agent.destroy();
  console.log(chalk.green('\n✅ 智能助手演示完成'));
}