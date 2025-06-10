import { Agent, ComponentManager, LLMManager, ToolComponent } from '../src/agent/index.js';
import { createToolManager } from '../src/tools/index.js';

/**
 * 重构后的 Agent 架构使用示例
 * 展示 LLM 管理器和组件管理器的分离使用
 */

async function main() {
  console.log('=== 重构后的 Agent 架构示例 ===\n');

  // 示例1: 直接使用 LLM 管理器
  await demonstrateLLMManager();

  // 示例2: 直接使用组件管理器
  await demonstrateComponentManager();

  // 示例3: 使用完整的 Agent（推荐方式）
  await demonstrateFullAgent();

  // 示例4: 高级用法 - 自定义管理器配置
  await demonstrateAdvancedUsage();
}

/**
 * 示例1: 直接使用 LLM 管理器
 */
async function demonstrateLLMManager() {
  console.log('=== 示例1: 直接使用 LLM 管理器 ===');

  try {
    // 创建独立的 LLM 管理器
    const llmManager = new LLMManager(true); // 启用调试

    // 配置 LLM
    llmManager.configure({
      provider: 'qwen',
      apiKey: process.env.QWEN_API_KEY || 'your-api-key',
      model: 'qwen3-235b-a22b',
    });

    // 初始化
    await llmManager.init();

    // 基础聊天
    const response = await llmManager.chat('你好，请介绍一下自己');
    console.log('LLM 回复:', response.substring(0, 100) + '...');

    // 检查状态
    console.log('LLM 状态:', llmManager.getStatus());

    // 销毁
    await llmManager.destroy();
    console.log('LLM 管理器已销毁\n');
  } catch (error) {
    console.error('LLM 管理器示例失败:', error);
  }
}

/**
 * 示例2: 直接使用组件管理器
 */
async function demonstrateComponentManager() {
  console.log('=== 示例2: 直接使用组件管理器 ===');

  try {
    // 创建独立的组件管理器
    const componentManager = new ComponentManager({
      debug: true,
      autoInit: true,
    });

    // 创建并注册工具组件
    const toolManager = await createToolManager();
    const toolComponent = new ToolComponent('tools', {
      debug: true,
      includeBuiltinTools: true,
    });

    await componentManager.registerComponent(toolComponent);

    // 初始化组件管理器
    await componentManager.init();

    // 获取组件状态
    console.log('组件管理器状态:', componentManager.getStatus());

    // 获取工具组件并使用
    const tools = componentManager.getComponent<ToolComponent>('tools');
    if (tools) {
      const availableTools = tools.getTools();
      console.log(`可用工具数量: ${availableTools.length}`);
      console.log(
        '前3个工具:',
        availableTools.slice(0, 3).map(t => t.name)
      );
    }

    // 检查健康状态
    const health = await componentManager.getHealthStatus();
    console.log('健康状态:', health.healthy ? '良好' : '异常');

    // 销毁
    await componentManager.destroy();
    console.log('组件管理器已销毁\n');
  } catch (error) {
    console.error('组件管理器示例失败:', error);
  }
}

/**
 * 示例3: 使用完整的 Agent（推荐方式）
 */
async function demonstrateFullAgent() {
  console.log('=== 示例3: 使用完整的 Agent ===');

  try {
    // 创建 Agent（推荐的统一方式）
    const agent = new Agent({
      debug: true,
      llm: {
        provider: 'qwen',
        apiKey: process.env.QWEN_API_KEY || 'your-api-key',
        model: 'qwen3-235b-a22b',
      },
      tools: {
        enabled: true,
        includeBuiltinTools: true,
      },
      context: {
        enabled: true,
      },
    });

    // 初始化
    await agent.init();

    // 访问内部管理器
    const llmManager = agent.getLLMManager();
    const componentManager = agent.getComponentManager();

    console.log('LLM 提供商:', llmManager.getProvider());
    console.log('组件数量:', componentManager.getComponentIds().length);

    // 使用智能聊天
    const smartResponse = await agent.smartChat('现在是几点？请告诉我当前时间');
    console.log('智能回复:', smartResponse.content);
    if (smartResponse.toolCalls && smartResponse.toolCalls.length > 0) {
      console.log('使用的工具:', smartResponse.toolCalls.map(t => t.toolName).join(', '));
    }

    // 检查整体健康状态
    const health = await agent.getHealthStatus();
    console.log('Agent 健康状态:', health.healthy ? '良好' : '异常');

    // 销毁
    await agent.destroy();
    console.log('Agent 已销毁\n');
  } catch (error) {
    console.error('完整 Agent 示例失败:', error);
  }
}

/**
 * 示例4: 高级用法 - 自定义管理器配置
 */
async function demonstrateAdvancedUsage() {
  console.log('=== 示例4: 高级用法 - 自定义管理器配置 ===');

  try {
    // 创建带有自定义配置的 Agent
    const agent = new Agent({
      debug: true,
      llm: {
        provider: 'qwen',
        apiKey: process.env.QWEN_API_KEY || 'your-api-key',
      },
      components: {
        debug: true,
        autoInit: false, // 禁用自动初始化
      },
      tools: {
        enabled: true,
        includeBuiltinTools: true,
        excludeTools: ['git_status'], // 排除特定工具
        includeCategories: ['utility', 'text'], // 只包含特定类别
      },
    });

    await agent.init();

    // 手动管理组件
    const componentManager = agent.getComponentManager();

    // 监听组件事件
    componentManager.on('componentRegistered', event => {
      console.log(`组件已注册: ${event.id}`);
    });

    componentManager.on('componentInitialized', event => {
      console.log(`组件已初始化: ${event.id}`);
    });

    // 运行时添加新组件
    const customComponent = new ToolComponent('custom-tools', {
      debug: true,
      includeBuiltinTools: false,
    });

    await componentManager.registerComponent(customComponent);

    // 重启特定组件
    const restartResult = await componentManager.restartComponent('tools');
    console.log('组件重启结果:', restartResult);

    // 获取详细状态信息
    const detailedStatus = agent.getStatus();
    console.log('详细状态:', JSON.stringify(detailedStatus, null, 2));

    // 批量操作
    const componentIds = componentManager.getComponentIds();
    console.log('所有组件ID:', componentIds);

    // 按类型搜索组件
    const toolComponents = componentManager.getComponentsByType(ToolComponent);
    console.log(`找到 ${toolComponents.length} 个工具组件`);

    await agent.destroy();
    console.log('高级用法演示完成\n');
  } catch (error) {
    console.error('高级用法示例失败:', error);
  }
}

/**
 * 展示架构优势
 */
async function demonstrateArchitecturalBenefits() {
  console.log('=== 架构优势展示 ===');

  console.log('1. 关注点分离:');
  console.log('   - Agent: 专注于代理协调逻辑');
  console.log('   - LLMManager: 专门管理 LLM 实例和操作');
  console.log('   - ComponentManager: 专门管理组件生命周期');

  console.log('\n2. 更好的可测试性:');
  console.log('   - 每个管理器可以独立测试');
  console.log('   - Agent 的协调逻辑可以 mock 管理器');

  console.log('\n3. 更高的可扩展性:');
  console.log('   - 可以轻松添加新的 LLM 提供商');
  console.log('   - 组件管理支持更复杂的生命周期');

  console.log('\n4. 更清晰的责任边界:');
  console.log('   - Agent 不再承担太多职责');
  console.log('   - 每个类的功能更加聚焦');

  console.log('\n5. 更好的错误处理:');
  console.log('   - 管理器级别的错误隔离');
  console.log('   - 更精确的状态管理');
}

// 运行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => {
      console.log('所有示例执行完成');
      demonstrateArchitecturalBenefits();
    })
    .catch(console.error);
}

export {
  demonstrateAdvancedUsage,
  demonstrateArchitecturalBenefits,
  demonstrateComponentManager,
  demonstrateFullAgent,
  demonstrateLLMManager,
};
