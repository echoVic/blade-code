/**
 * 上下文管理模块使用示例
 */

import { createContextManager } from './index.js';

async function example() {
  // 创建上下文管理器
  const contextManager = createContextManager({
    storage: {
      maxMemorySize: 500,
      persistentPath: './example-context',
      cacheSize: 50,
      compressionEnabled: true,
    },
    defaultFilter: {
      maxTokens: 2000,
      maxMessages: 30,
    },
    compressionThreshold: 3000,
  });

  try {
    // 初始化
    await contextManager.initialize();
    console.log('✅ 上下文管理器初始化成功');

    // 创建新会话
    const sessionId = await contextManager.createSession('demo-user', {
      language: 'zh-CN',
      projectType: 'typescript',
    });
    console.log(`✅ 创建会话: ${sessionId}`);

    // 添加系统消息
    await contextManager.addMessage('system', '你是一个专业的 TypeScript 开发助手。');

    // 添加用户消息
    await contextManager.addMessage(
      'user',
      '我想创建一个 TypeScript 项目，可以帮我设计架构吗？'
    );

    // 添加助手回复
    await contextManager.addMessage(
      'assistant',
      '当然可以！我来帮您设计一个现代化的 TypeScript 项目架构。首先让我了解一下您的项目需求...'
    );

    // 添加工具调用记录
    await contextManager.addToolCall({
      id: 'tool_001',
      name: 'create_file',
      input: { path: './src/index.ts', content: 'console.log("Hello World");' },
      output: { success: true, message: '文件创建成功' },
      timestamp: Date.now(),
      status: 'success',
    });

    // 更新工作空间信息
    contextManager.updateWorkspace({
      currentFiles: ['src/index.ts', 'package.json'],
      recentFiles: ['src/index.ts'],
    });

    // 获取格式化的上下文
    const { context, compressed, tokenCount } =
      await contextManager.getFormattedContext({
        maxTokens: 1500,
        includeTools: true,
        includeWorkspace: true,
      });

    console.log(`📊 上下文信息:`);
    console.log(`- Token 数量: ${tokenCount}`);
    console.log(`- 消息数量: ${context.layers.conversation.messages.length}`);
    console.log(`- 是否压缩: ${compressed ? '是' : '否'}`);

    if (compressed) {
      console.log(`- 压缩摘要: ${compressed.summary}`);
      console.log(`- 关键要点: ${compressed.keyPoints.join(', ')}`);
    }

    // 获取统计信息
    const stats = await contextManager.getStats();
    console.log('\n📈 管理器统计:');
    console.log(`- 当前会话: ${stats.currentSession}`);
    console.log(`- 内存消息数: ${stats.memory.messageCount}`);
    console.log(`- 缓存大小: ${stats.cache.size}`);
    console.log(`- 存储会话数: ${stats.storage.totalSessions}`);

    // 测试会话搜索
    const sessions = await contextManager.searchSessions('TypeScript');
    console.log(`\n🔍 找到 ${sessions.length} 个相关会话`);

    // 清理资源
    await contextManager.cleanup();
    console.log('✅ 资源清理完成');
  } catch (error) {
    console.error('❌ 示例运行出错:', error);
  }
}

// 如果直接运行此文件，则执行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}

export { example };
