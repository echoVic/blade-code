import { QwenLLM } from '../src/llm/QwenLLM.js';
import { createToolManager, ToolFormatConverter } from '../src/tools/index.js';

/**
 * Qwen Function Call 功能示例
 * 演示如何使用 Qwen 模型的现代 tools 接口和传统 functions 接口
 */

async function main() {
  console.log('=== Qwen Function Call 示例 ===\n');

  // 初始化 Qwen LLM
  const qwenLLM = new QwenLLM({
    apiKey: process.env.QWEN_API_KEY || 'your-api-key',
    // baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', // 可选
  });

  await qwenLLM.init();

  // 创建工具管理器
  const toolManager = await createToolManager();
  const availableTools = toolManager.getAllTools();

  console.log(`已加载 ${availableTools.length} 个工具\n`);

  // 示例1: 使用现代 Tools 格式
  await demonstrateToolsFormat(qwenLLM, availableTools);

  // 示例2: 使用传统 Functions 格式
  await demonstrateFunctionsFormat(qwenLLM, availableTools);

  // 示例3: 自动选择最佳格式
  await demonstrateSmartFunctionCall(qwenLLM, availableTools);

  // 示例4: 完整的工具调用工作流
  await demonstrateToolWorkflow(qwenLLM, toolManager);
}

/**
 * 示例1: 使用现代 OpenAI Tools 格式
 */
async function demonstrateToolsFormat(qwenLLM: QwenLLM, availableTools: any[]) {
  console.log('=== 示例1: 现代 Tools 格式 ===');

  try {
    // 选择几个工具进行演示
    const selectedTools = availableTools.slice(0, 3);
    const tools = ToolFormatConverter.toOpenAITools(selectedTools);

    console.log('使用的工具:', tools.map(t => t.function.name).join(', '));

    const messages = [
      {
        role: 'user',
        content: '请查看当前时间，并告诉我现在是什么时候',
      },
    ];

    const response = await qwenLLM.toolsCall(messages, tools);
    const result = qwenLLM.parseToolCallResult(response);

    console.log('LLM 回复:', result.content);
    if (result.hasToolCalls) {
      console.log('工具调用:', result.toolCalls.map(t => t.function.name).join(', '));
    }
    console.log('');
  } catch (error) {
    console.error('Tools 格式调用失败:', error);
    console.log('');
  }
}

/**
 * 示例2: 使用传统 Functions 格式
 */
async function demonstrateFunctionsFormat(qwenLLM: QwenLLM, availableTools: any[]) {
  console.log('=== 示例2: 传统 Functions 格式 ===');

  try {
    const selectedTools = availableTools.slice(0, 3);
    const functions = ToolFormatConverter.toOpenAIFunctions(selectedTools);

    console.log('使用的函数:', functions.map(f => f.name).join(', '));

    const messages = [
      {
        role: 'user',
        content: '帮我生成一个UUID',
      },
    ];

    const response = await qwenLLM.functionCall(messages, functions);
    const result = qwenLLM.parseToolCallResult(response);

    console.log('LLM 回复:', result.content);
    if (result.hasToolCalls) {
      console.log('函数调用:', result.toolCalls.map(t => t.function.name).join(', '));
    }
    console.log('');
  } catch (error) {
    console.error('Functions 格式调用失败:', error);
    console.log('');
  }
}

/**
 * 示例3: 智能选择最佳格式
 */
async function demonstrateSmartFunctionCall(qwenLLM: QwenLLM, availableTools: any[]) {
  console.log('=== 示例3: 智能格式选择 ===');

  try {
    const selectedTools = availableTools.slice(0, 5);

    console.log('使用智能格式选择，支持的工具:', selectedTools.map(t => t.name).join(', '));

    const messages = [
      {
        role: 'user',
        content: '帮我查看当前目录下的文件列表',
      },
    ];

    // 智能选择最佳格式
    const response = await qwenLLM.smartFunctionCall(messages, selectedTools);
    const result = qwenLLM.parseToolCallResult(response);

    console.log('LLM 回复:', result.content);
    if (result.hasToolCalls) {
      console.log('选择的工具:', result.toolCalls.map(t => t.function.name).join(', '));

      // 显示工具调用参数
      for (const toolCall of result.toolCalls) {
        console.log(`${toolCall.function.name} 参数:`, toolCall.function.arguments);
      }
    }
    console.log('');
  } catch (error) {
    console.error('智能格式选择失败:', error);
    console.log('');
  }
}

/**
 * 示例4: 完整的工具调用工作流
 */
async function demonstrateToolWorkflow(qwenLLM: QwenLLM, toolManager: any) {
  console.log('=== 示例4: 完整工具调用工作流 ===');

  try {
    const availableTools = toolManager.getAllTools().slice(0, 8);
    console.log('工作流使用的工具:', availableTools.map(t => t.name).join(', '));

    const messages = [
      {
        role: 'user',
        content: '请告诉我现在的时间，然后生成一个随机UUID，最后计算一下字符串长度',
      },
    ];

    // 工具执行器
    const toolExecutor = async (toolName: string, args: any) => {
      console.log(`执行工具: ${toolName}，参数:`, args);
      const response = await toolManager.callTool({
        toolName,
        parameters: args,
      });
      return response.result.data;
    };

    // 执行完整工作流
    const result = await qwenLLM.executeToolWorkflow(messages, availableTools, toolExecutor);

    console.log('\n=== 工作流结果 ===');
    console.log('最终回复:', result.finalResponse);
    console.log(`\n执行了 ${result.toolExecutions.length} 个工具:`);

    for (const execution of result.toolExecutions) {
      const status = execution.success ? '✅' : '❌';
      console.log(
        `${status} ${execution.toolName}: ${execution.success ? '成功' : execution.error}`
      );
      if (execution.success && execution.result) {
        console.log(`   结果: ${JSON.stringify(execution.result)}`);
      }
    }
    console.log('');
  } catch (error) {
    console.error('工具工作流失败:', error);
    console.log('');
  }
}

/**
 * 工具格式转换示例
 */
async function demonstrateFormatConversion() {
  console.log('=== 工具格式转换示例 ===');

  const toolManager = await createToolManager();
  const tools = toolManager.getAllTools().slice(0, 3);

  console.log('原始工具定义:');
  tools.forEach(tool => {
    console.log(`- ${tool.name}: ${tool.description}`);
  });

  console.log('\n转换为 OpenAI Tools 格式:');
  const openaiTools = ToolFormatConverter.toOpenAITools(tools);
  console.log(JSON.stringify(openaiTools[0], null, 2));

  console.log('\n转换为 OpenAI Functions 格式:');
  const openaiFunctions = ToolFormatConverter.toOpenAIFunctions(tools);
  console.log(JSON.stringify(openaiFunctions[0], null, 2));

  console.log('\n为 Qwen 优化的格式:');
  const optimizedTools = ToolFormatConverter.optimizeForQwen(openaiTools);
  console.log('优化后的描述:', optimizedTools[0].function.description);

  console.log('\n生成调用示例:');
  const example = ToolFormatConverter.generateExample(openaiTools[0]);
  console.log(example);
}

// 运行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export {
  demonstrateFormatConversion,
  demonstrateFunctionsFormat,
  demonstrateSmartFunctionCall,
  demonstrateToolsFormat,
  demonstrateToolWorkflow,
};
