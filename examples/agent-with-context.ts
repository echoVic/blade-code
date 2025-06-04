/**
 * Agent 集成上下文管理示例
 * 演示如何使用带有上下文记忆功能的智能代理
 */

import { Agent } from '../src/agent/index.js';

async function agentWithContextExample() {
  console.log('🚀 开始 Agent 上下文管理示例...\n');

  // 创建配置了上下文管理的 Agent
  const agent = new Agent({
    debug: true,
    llm: {
      provider: 'qwen',
      apiKey: process.env.QWEN_API_KEY, // 需要配置环境变量
      model: 'qwen-turbo',
    },
    tools: {
      enabled: true,
      includeBuiltinTools: true,
    },
    context: {
      enabled: true,
      debug: true,
      storage: {
        maxMemorySize: 500,
        persistentPath: './example-agent-context',
        cacheSize: 50,
      },
      defaultFilter: {
        maxTokens: 3000,
        maxMessages: 20,
      },
    },
  });

  try {
    // 初始化 Agent
    await agent.init();
    console.log('✅ Agent 初始化完成\n');

    // 创建新的上下文会话
    const sessionId = await agent.createContextSession('demo-user', {
      language: 'zh-CN',
      expertise: 'TypeScript开发',
    });
    console.log(`📋 创建会话: ${sessionId}\n`);

    // 进行多轮对话，验证上下文记忆功能
    console.log('💬 开始多轮对话测试...\n');

    // 第一轮：介绍项目
    const response1 = await agent.chatWithContext(
      '我正在开发一个基于TypeScript的AI代理CLI工具，叫做blade-ai。目前已经实现了LLM对话和工具调用功能。',
      '你是一个专业的TypeScript开发助手，善于提供技术建议和代码审查。'
    );
    console.log('👤 用户: 我正在开发一个基于TypeScript的AI代理CLI工具...');
    console.log(`🤖 助手: ${response1}\n`);

    // 第二轮：询问技术细节（测试上下文记忆）
    const response2 = await agent.chatWithContext(
      '现在我想为这个项目添加上下文管理功能，你觉得应该如何设计？'
    );
    console.log('👤 用户: 现在我想为这个项目添加上下文管理功能...');
    console.log(`🤖 助手: ${response2}\n`);

    // 第三轮：具体实现问题
    const response3 = await agent.chatWithContext(
      '我已经实现了分层上下文架构，但在TypeScript类型检查时遇到了一些问题。'
    );
    console.log('👤 用户: 我已经实现了分层上下文架构，但在TypeScript类型检查时遇到了一些问题。');
    console.log(`🤖 助手: ${response3}\n`);

    // 测试智能工具调用（带上下文）
    console.log('🔧 测试智能工具调用（带上下文）...\n');

    const toolResponse = await agent.smartChatWithContext(
      '帮我查看一下当前目录的文件结构，并分析项目的整体架构。'
    );
    console.log('👤 用户: 帮我查看一下当前目录的文件结构...');
    console.log(`🤖 助手: ${toolResponse.content}`);

    if (toolResponse.toolCalls && toolResponse.toolCalls.length > 0) {
      console.log('\n🛠️ 工具调用记录:');
      toolResponse.toolCalls.forEach((tool, index) => {
        console.log(`${index + 1}. ${tool.toolName}: ${tool.success ? '✅ 成功' : '❌ 失败'}`);
      });
    }
    console.log();

    // 获取上下文统计信息
    const contextStats = await agent.getContextStats();
    if (contextStats) {
      console.log('📊 上下文统计信息:');
      console.log(`- 当前会话: ${contextStats.currentSession}`);
      console.log(`- 内存中消息数: ${contextStats.memory.messageCount}`);
      console.log(`- 缓存大小: ${contextStats.cache.size}`);
      console.log(`- 存储的会话数: ${contextStats.storage.totalSessions}`);
      console.log();
    }

    // 测试会话搜索功能
    console.log('🔍 测试会话搜索功能...\n');
    const sessions = await agent.searchContextSessions('TypeScript');
    console.log(`找到 ${sessions.length} 个相关会话:`);
    sessions.forEach((session, index) => {
      console.log(`${index + 1}. ${session.sessionId}: ${session.summary}`);
    });
    console.log();

    // 模拟加载历史会话
    console.log('📂 测试会话加载功能...\n');

    // 创建另一个会话来演示
    const newSessionId = await agent.createContextSession('demo-user-2', {
      language: 'zh-CN',
      project: '新项目讨论',
    });

    await agent.chatWithContext('这是一个新的会话，我想讨论React项目的最佳实践。');

    // 切换回原会话
    const loadSuccess = await agent.loadContextSession(sessionId);
    console.log(`加载原会话 ${loadSuccess ? '成功' : '失败'}: ${sessionId}`);

    // 验证上下文是否正确恢复
    const contextResponse = await agent.chatWithContext(
      '刚才我们讨论的blade-ai项目，你还记得我遇到的TypeScript类型问题吗？'
    );
    console.log('👤 用户: 刚才我们讨论的blade-ai项目，你还记得我遇到的TypeScript类型问题吗？');
    console.log(`🤖 助手: ${contextResponse}\n`);

    console.log('✅ 上下文管理功能测试完成！');
  } catch (error) {
    console.error('❌ 示例运行出错:', error);
  } finally {
    // 清理资源
    await agent.destroy();
    console.log('🧹 资源清理完成');
  }
}

// 如果直接运行此文件，则执行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  agentWithContextExample().catch(console.error);
}

export { agentWithContextExample };
