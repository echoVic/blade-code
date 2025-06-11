import chalk from 'chalk';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { agentLlmCommand } from './commands/agent-llm.js';
import { configCommand } from './commands/config.js';
import { llmCommand } from './commands/llm.js';
import { mcpCommand } from './commands/mcp.js';
import { toolsCommand } from './commands/tools.js';

// 获取当前模块的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取 package.json 获取版本号
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

// 导出 Agent 和 LLM 相关模块
export { Agent, AgentConfig, AgentResponse, ToolCallResult } from './agent/Agent.js';
export { BaseComponent } from './agent/BaseComponent.js';
export { LoggerComponent } from './agent/LoggerComponent.js';
export { ToolComponent, ToolComponentConfig } from './agent/ToolComponent.js';

// LLM 模块
export { BaseLLM } from './llm/BaseLLM.js';
export { QwenLLM } from './llm/QwenLLM.js';
export { VolcEngineLLM } from './llm/VolcEngineLLM.js';

// 配置模块
export {
  DEFAULT_CONFIG,
  getProviderConfig,
  getSupportedProviders,
  isProviderSupported,
  loadConfigFromEnv,
} from './config/defaults.js';
export type { DefaultConfig, LLMProviderConfig } from './config/defaults.js';

// 工具模块
export {
  createToolManager,
  fileSystemTools,
  getAllBuiltinTools,
  getBuiltinToolsByCategory,
  gitTools,
  networkTools,
  smartTools,
  textProcessingTools,
  ToolExecutionError,
  ToolManager,
  ToolRegistrationError,
  ToolValidationError,
  ToolValidator,
  utilityTools,
} from './tools/index.js';

export type {
  ToolCallRequest,
  ToolCallResponse,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionHistory,
  ToolExecutionResult,
  ToolManagerConfig,
  ToolParameterSchema,
  ToolRegistrationOptions,
} from './tools/index.js';

// 类型定义
export type { LLMMessage, LLMRequest, LLMResponse } from './llm/BaseLLM.js';

// MCP 模块
export * from './mcp/index.js';

const program = new Command();

// 设置基本信息
program.name('blade').description('🗡️ Blade - 智能 AI 助手命令行工具').version(version);

// 注册 LLM 相关命令
agentLlmCommand(program);
llmCommand(program);

// 注册配置相关命令
configCommand(program);

// 注册工具相关命令
toolsCommand(program);

// 注册 MCP 相关命令
mcpCommand(program);

// 添加帮助信息
program.on('--help', () => {
  console.log('');
  console.log(chalk.blue('🚀 Blade 使用示例:'));
  console.log('');

  console.log(chalk.green('  💬 智能对话:'));
  console.log('  $ blade chat 什么是人工智能');
  console.log('  $ blade chat 解释一下微服务架构');
  console.log('  $ blade chat --scenario customer 怎么退货');
  console.log('  $ blade chat --stream 详细解释机器学习');
  console.log('');

  console.log(chalk.green('  🔄 交互式聊天:'));
  console.log('  $ blade chat --interactive');
  console.log('  $ blade chat -i --scenario code --stream');
  console.log('');

  console.log(chalk.green('  🧠 带上下文记忆的聊天:'));
  console.log('  $ blade chat --context --interactive');
  console.log('  $ blade chat --context "你还记得我之前问的问题吗？"');
  console.log('  $ blade chat --context --context-session my-session');
  console.log('  $ blade chat --context --context-user john --interactive');
  console.log('');

  console.log(chalk.green('  🎭 场景演示:'));
  console.log('  $ blade chat --demo --scenario assistant');
  console.log('  $ blade chat --demo --scenario customer');
  console.log('');

  console.log(chalk.green('  🤖 纯 LLM 模式:'));
  console.log('  $ blade llm --stream');
  console.log('  $ blade llm --provider volcengine');
  console.log('');

  console.log(chalk.green('  📋 模型管理:'));
  console.log('  $ blade models --provider qwen');
  console.log('  $ blade models --provider volcengine');
  console.log('');

  console.log(chalk.green('  ⚙️ 配置管理:'));
  console.log('  $ blade config show');
  console.log('  $ blade config set-provider volcengine');
  console.log('  $ blade config set-model ep-20250530171222-q42h8');
  console.log('  $ blade config switch');
  console.log('  $ blade config wizard');
  console.log('');

  console.log(chalk.green('  🔧 工具管理:'));
  console.log('  $ blade tools list');
  console.log('  $ blade tools info smart_code_review');
  console.log('  $ blade tools call uuid');
  console.log('  $ blade tools call command_confirmation \\');
  console.log('    --params \'{"command": "ls -la", "description": "查看文件"}\'');
  console.log('');

  console.log(chalk.green('  🔗 MCP 支持:'));
  console.log('  $ blade mcp server start');
  console.log('  $ blade mcp config add');
  console.log('  $ blade mcp client connect my-server');
  console.log('  $ blade chat --mcp my-server "使用外部资源分析"');
  console.log('');

  console.log(chalk.blue('✨ 命令确认功能:'));
  console.log(chalk.gray('  • 📋 命令展示 - 清晰显示建议的命令和说明'));
  console.log(chalk.gray('  • 🔍 风险评估 - 自动显示命令的风险级别'));
  console.log(chalk.gray('  • ✅ 用户确认 - 交互式确认是否执行'));
  console.log(chalk.gray('  • ⚡ 实时执行 - 确认后立即执行命令'));
  console.log(chalk.gray('  • 📊 执行统计 - 显示执行时间和结果'));
  console.log('');

  console.log(chalk.yellow('💡 提示: 使用 "blade chat 你的问题" 进行智能对话'));
  console.log(chalk.yellow('        使用命令确认工具安全执行AI建议的命令'));
  console.log(chalk.yellow('        在对话中说"请使用命令确认工具执行..."'));
});

if (!process.argv.slice(2).length) {
  console.log(chalk.cyan('🗡️ 欢迎使用 Blade！'));
  console.log('');
  program.outputHelp();
  process.exit(0);
}

// 解析命令行参数
program.parse(process.argv);
