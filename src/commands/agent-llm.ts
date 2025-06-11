import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { getModelDescription, getProviderConfig, isProviderSupported } from '../config/defaults.js';
import { getCurrentModel, getCurrentProvider } from '../config/user-config.js';
import { LLMMessage } from '../llm/BaseLLM.js';

/**
 * 注册智能聊天命令
 */
export function agentLlmCommand(program: Command) {
  program
    .command('chat')
    .description('🤖 智能 Agent 聊天')
    .argument('[question...]', '要问的问题（可选）')
    .option('-p, --provider <provider>', '选择 LLM 提供商 (volcengine|qwen)')
    .option('-k, --api-key <key>', 'API 密钥')
    .option('-m, --model <model>', '指定模型')
    .option('-s, --scenario <scenario>', '选择场景 (customer|code|assistant)', 'assistant')
    .option('-i, --interactive', '启动交互式聊天模式', false)
    .option('--stream', '启用流式输出', false)
    .option('--demo', '运行场景演示', false)
    .option('--context', '启用上下文管理（记住对话历史）', false)
    .option('--context-session <sessionId>', '加载指定的上下文会话')
    .option('--context-user <userId>', '指定用户ID用于上下文管理', 'default-user')
    .option('--mcp [servers...]', '启用 MCP 并连接到指定服务器（可指定多个）')
    .action(async (questionArgs, options) => {
      try {
        // 使用用户配置作为默认值
        const provider = options.provider || getCurrentProvider();

        // 验证提供商
        if (!isProviderSupported(provider)) {
          console.log(chalk.red(`❌ 不支持的提供商: ${provider}`));
          console.log(chalk.gray('支持的提供商: qwen, volcengine'));
          return;
        }

        // 获取模型（优先级：命令行 > 用户配置 > 默认）
        const userModel = getCurrentModel(provider);
        const defaultModel = getProviderConfig(provider).defaultModel;
        const model = options.model || userModel || defaultModel;

        // 创建 Agent 配置
        const agentConfig: AgentConfig = {
          debug: false,
          llm: {
            provider: provider,
            apiKey: options.apiKey,
            model: model,
          },
          tools: {
            enabled: true,
            includeBuiltinTools: true,
          },
          context: options.context
            ? {
                enabled: true,
                debug: false,
                storage: {
                  maxMemorySize: 1000,
                  persistentPath: './blade-context',
                  cacheSize: 100,
                  compressionEnabled: true,
                },
                defaultFilter: {
                  maxTokens: 4000,
                  maxMessages: 50,
                  timeWindow: 24 * 60 * 60 * 1000, // 24小时
                  includeTools: true,
                  includeWorkspace: true,
                },
                compressionThreshold: 6000,
              }
            : {
                enabled: false,
              },
          mcp: options.mcp
            ? {
                enabled: true,
                servers: Array.isArray(options.mcp) ? options.mcp : [],
                autoConnect: true,
                debug: false,
              }
            : {
                enabled: false,
              },
        };

        // 初始化 Agent
        console.log(chalk.blue('🤖 启动智能 Agent...'));
        if (options.context) {
          console.log(chalk.cyan('🧠 上下文管理已启用'));
        }
        if (options.mcp) {
          const serverList = Array.isArray(options.mcp) ? options.mcp : [];
          if (serverList.length > 0) {
            console.log(chalk.cyan(`🔗 MCP 已启用，将连接到: ${serverList.join(', ')}`));
          } else {
            console.log(chalk.cyan('🔗 MCP 已启用'));
          }
        }

        const agent = new Agent(agentConfig);

        try {
          await agent.init();
        } catch (error) {
          // 检查是否是API密钥相关错误
          const errorMessage = (error as Error).message;
          if (errorMessage.includes('API密钥') || errorMessage.includes('API key')) {
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
            if (provider === 'qwen') {
              console.log(chalk.gray('千问: https://dashscope.console.aliyun.com/apiKey'));
            } else if (provider === 'volcengine') {
              console.log(
                chalk.gray(
                  '火山引擎: https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
                )
              );
            }
            return;
          }
          throw error;
        }

        const modelDescription = getModelDescription(provider, model);
        console.log(chalk.green(`✅ 使用 ${provider} (${modelDescription})`));

        // 处理上下文会话
        if (options.context) {
          if (options.contextSession) {
            // 加载指定会话
            const loaded = await agent.loadContextSession(options.contextSession);
            if (loaded) {
              console.log(chalk.green(`📂 已加载会话: ${options.contextSession}`));
            } else {
              console.log(chalk.yellow(`⚠️ 会话不存在，将创建新会话: ${options.contextSession}`));
              await agent.createContextSession(
                options.contextUser,
                {
                  sessionId: options.contextSession,
                  scenario: options.scenario,
                },
                {},
                options.contextSession // 传递自定义sessionId
              );
            }
          } else {
            // 创建新会话
            const sessionId = await agent.createContextSession(options.contextUser, {
              scenario: options.scenario,
              startTime: Date.now(),
            });
            console.log(chalk.cyan(`📋 已创建会话: ${sessionId}`));
          }
        }

        // 判断聊天模式
        const question = questionArgs.join(' ');

        if (options.demo) {
          // 演示模式
          agentConfig.debug = true; // 演示时显示调试信息
          await runScenarioDemo(agentConfig, options.scenario);
        } else if (question) {
          // 单次问答模式
          await answerSingleQuestion(
            agent,
            question,
            options.scenario,
            options.stream,
            options.context
          );
        } else if (options.interactive) {
          // 交互式聊天模式
          await startInteractiveChat(agent, options.scenario, options.stream, options.context);
        } else {
          // 默认：启动交互式聊天
          await startInteractiveChat(agent, options.scenario, options.stream, options.context);
        }

        // 确保清理资源
        await agent.destroy();
      } catch (error) {
        console.error(chalk.red('❌ 启动失败:'), error);
      }
    });
}

/**
 * 单次问答
 */
async function answerSingleQuestion(
  agent: Agent,
  question: string,
  scenario: string,
  useStream: boolean = false,
  useContext: boolean = false
) {
  try {
    let response: string;

    if (useStream) {
      // 流式输出模式
      console.log(chalk.green('\n💬 AI: '), { newline: false });

      switch (scenario) {
        case 'customer':
          if (useContext) {
            response = await agent.chatWithContext(
              question,
              '你是专业的客服代表，友好耐心地解答问题'
            );
            console.log(response);
          } else {
            const messages: LLMMessage[] = [
              { role: 'system', content: '你是专业的客服代表，友好耐心地解答问题' },
              { role: 'user', content: question },
            ];
            response = await agent.streamChat(messages, chunk => {
              process.stdout.write(chunk);
            });
          }
          break;
        case 'code':
          // 代码场景直接使用非流式，因为需要工具调用
          response = await agent.reviewCode(question, 'auto-detect');
          console.log(response);
          break;
        case 'assistant':
        default:
          // 智能助手模式的流式输出
          if (useContext) {
            const smartResponse = await agent.smartChatWithContext(question);

            if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
              const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
              console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
              if (smartResponse.reasoning) {
                console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
              }
            }
            console.log(smartResponse.content);
          } else {
            const smartResponse = await agent.smartChat(question);

            if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
              const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
              console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
              if (smartResponse.reasoning) {
                console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
              }
              console.log(chalk.green('\n💬 AI: '));
              console.log(smartResponse.content);
            } else {
              const messages: LLMMessage[] = [{ role: 'user', content: question }];
              response = await agent.streamChat(messages, chunk => {
                process.stdout.write(chunk);
              });
            }
          }
          break;
      }
      console.log('\n'); // 流式输出后换行
    } else {
      // 普通输出模式
      switch (scenario) {
        case 'customer':
          if (useContext) {
            response = await agent.chatWithContext(
              question,
              '你是专业的客服代表，友好耐心地解答问题'
            );
          } else {
            const systemPrompt = '你是专业的客服代表，友好耐心地解答问题';
            response = await agent.chatWithSystem(systemPrompt, question);
          }
          break;
        case 'code':
          response = await agent.reviewCode(question, 'auto-detect');
          break;
        case 'assistant':
        default:
          // 使用智能聊天，支持工具调用
          if (useContext) {
            const smartResponse = await agent.smartChatWithContext(question);
            response = smartResponse.content;

            if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
              const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
              console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
              if (smartResponse.reasoning) {
                console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
              }
            }
          } else {
            const smartResponse = await agent.smartChat(question);
            response = smartResponse.content;

            if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
              const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
              console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
              if (smartResponse.reasoning) {
                console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
              }
            }
          }
          break;
      }
      console.log(chalk.green(`\n💬 AI: ${response}`));
    }
  } catch (error) {
    console.error(chalk.red('❌ 聊天错误:'), error);
  }
}

/**
 * 交互式聊天
 */
async function startInteractiveChat(
  agent: Agent,
  scenario: string,
  useStream: boolean = false,
  useContext: boolean = false
) {
  console.log(chalk.cyan(`\n=== 🤖 ${getScenarioName(scenario)} ===`));
  if (useContext) {
    console.log(chalk.gray('🧠 上下文记忆已启用 - 我会记住我们的对话'));

    // 显示当前会话信息
    const sessionId = agent.getCurrentSessionId();
    if (sessionId) {
      console.log(chalk.gray(`📋 当前会话: ${sessionId}`));
    }
  }
  console.log(chalk.gray('输入 "quit" 或 "exit" 退出聊天'));
  console.log(chalk.gray('输入 "stats" 查看上下文统计信息'));
  console.log(chalk.gray('输入 "sessions" 搜索历史会话\n'));

  try {
    while (true) {
      const { message } = await inquirer.prompt([
        {
          type: 'input',
          name: 'message',
          message: '你:',
        },
      ]);

      if (!message.trim()) {
        continue;
      }

      if (message.toLowerCase() === 'quit' || message.toLowerCase() === 'exit') {
        console.log(chalk.blue('👋 再见！'));
        break;
      }

      // 特殊命令处理
      if (message.toLowerCase() === 'stats' && useContext) {
        const stats = await agent.getContextStats();
        if (stats) {
          console.log(chalk.cyan('\n📊 上下文统计信息:'));
          console.log(chalk.gray(`- 当前会话: ${stats.currentSession}`));
          console.log(chalk.gray(`- 内存消息数: ${stats.memory.messageCount}`));
          console.log(chalk.gray(`- 缓存大小: ${stats.cache.size}`));
          console.log(chalk.gray(`- 存储会话数: ${stats.storage.totalSessions}\n`));
        }
        continue;
      }

      if (message.toLowerCase() === 'sessions' && useContext) {
        try {
          const sessions = await agent.searchContextSessions('', 5);
          if (sessions.length > 0) {
            console.log(chalk.cyan('\n📂 最近的会话:'));
            sessions.forEach((session, index) => {
              const date = new Date(session.lastActivity).toLocaleString();
              console.log(chalk.gray(`${index + 1}. ${session.sessionId} (${date})`));
              if (session.summary) {
                console.log(chalk.gray(`   ${session.summary}`));
              }
            });
            console.log();
          } else {
            console.log(chalk.yellow('📂 暂无历史会话\n'));
          }
        } catch (error) {
          console.log(chalk.red('❌ 获取会话列表失败\n'));
        }
        continue;
      }

      try {
        let response: string;

        if (useStream) {
          // 流式输出模式
          console.log(chalk.green('AI: '), { newline: false });

          switch (scenario) {
            case 'customer':
              if (useContext) {
                response = await agent.chatWithContext(
                  message,
                  '你是专业的客服代表，友好耐心地解答问题'
                );
                console.log(response);
              } else {
                const customerMessages: LLMMessage[] = [
                  { role: 'system', content: '你是专业的客服代表，友好耐心地解答问题' },
                  { role: 'user', content: message },
                ];
                response = await agent.streamChat(customerMessages, chunk => {
                  process.stdout.write(chunk);
                });
              }
              break;
            case 'code':
              if (
                message.includes('```') ||
                message.includes('function') ||
                message.includes('class')
              ) {
                response = await agent.reviewCode(message, 'auto-detect');
                console.log(response);
              } else {
                if (useContext) {
                  response = await agent.chatWithContext(`作为代码助手，${message}`);
                  console.log(response);
                } else {
                  const codeMessages: LLMMessage[] = [
                    { role: 'user', content: `作为代码助手，${message}` },
                  ];
                  response = await agent.streamChat(codeMessages, chunk => {
                    process.stdout.write(chunk);
                  });
                }
              }
              break;
            case 'assistant':
            default:
              // 智能助手模式
              if (useContext) {
                const smartResponse = await agent.smartChatWithContext(message);

                if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
                  const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
                  console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
                  if (smartResponse.reasoning) {
                    console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
                  }
                }
                console.log(chalk.green('AI: '));
                console.log(smartResponse.content);
              } else {
                const smartResponse = await agent.smartChat(message);

                if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
                  const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
                  console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
                  if (smartResponse.reasoning) {
                    console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
                  }
                  console.log(chalk.green('AI: '));
                  console.log(smartResponse.content);
                } else {
                  const assistantMessages: LLMMessage[] = [{ role: 'user', content: message }];
                  response = await agent.streamChat(assistantMessages, chunk => {
                    process.stdout.write(chunk);
                  });
                }
              }
              break;
          }
          console.log('\n'); // 流式输出后换行
        } else {
          // 普通输出模式
          switch (scenario) {
            case 'customer':
              if (useContext) {
                response = await agent.chatWithContext(
                  message,
                  '你是专业的客服代表，友好耐心地解答问题'
                );
              } else {
                const systemPrompt = '你是专业的客服代表，友好耐心地解答问题';
                response = await agent.chatWithSystem(systemPrompt, message);
              }
              break;
            case 'code':
              if (
                message.includes('```') ||
                message.includes('function') ||
                message.includes('class')
              ) {
                response = await agent.reviewCode(message, 'auto-detect');
              } else {
                if (useContext) {
                  response = await agent.chatWithContext(`作为代码助手，${message}`);
                } else {
                  response = await agent.ask(`作为代码助手，${message}`);
                }
              }
              break;
            case 'assistant':
            default:
              // 使用智能聊天，支持工具调用
              if (useContext) {
                const smartResponse = await agent.smartChatWithContext(message);
                response = smartResponse.content;

                if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
                  const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
                  console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
                  if (smartResponse.reasoning) {
                    console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
                  }
                }
              } else {
                const smartResponse = await agent.smartChat(message);
                response = smartResponse.content;

                if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
                  const toolNames = smartResponse.toolCalls.map(t => t.toolName).join(', ');
                  console.log(chalk.gray(`🔧 使用的工具: ${toolNames}`));
                  if (smartResponse.reasoning) {
                    console.log(chalk.gray(`💭 推理过程: ${smartResponse.reasoning}`));
                  }
                }
              }
              break;
          }
          console.log(chalk.green(`AI: ${response}\n`));
        }
      } catch (error) {
        console.error(chalk.red('❌ 聊天错误:'), error);
      }
    }
  } finally {
    // Agent会在主函数中被销毁
  }
}

/**
 * 运行场景演示
 */
async function runScenarioDemo(config: AgentConfig, scenario: string) {
  console.log(chalk.cyan('🎭 场景演示模式'));
  console.log(chalk.gray('注意：演示模式暂不支持上下文管理\n'));

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
    case 'customer':
      return '智能客服';
    case 'code':
      return '代码助手';
    case 'assistant':
      return '智能助手';
    default:
      return '智能助手';
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
    '请问你们有什么优惠活动吗？',
  ];

  for (const inquiry of scenarios) {
    console.log(chalk.yellow(`\n客户: ${inquiry}`));

    try {
      const systemPrompt = '你是专业的客服代表，友好耐心地解答问题';
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
  console.log(
    chalk.gray(`Agent 状态: LLM=${status.llmProvider}, 组件数=${status.components.componentCount}`)
  );

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
      { role: 'user' as const, content: '请简单解释什么是区块链技术' },
    ];

    await agent.streamChat(messages, chunk => {
      process.stdout.write(chunk);
    });
    console.log('\n');
  } catch (error) {
    console.error(chalk.red('❌ 助手操作失败:'), error);
  }

  await agent.destroy();
  console.log(chalk.green('\n✅ 智能助手演示完成'));
}
