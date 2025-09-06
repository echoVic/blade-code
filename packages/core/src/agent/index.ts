/**
 * Agent模块导出 - 简化架构
 */

// 核心Agent类
export { Agent } from './Agent.js';
export type { AgentConfig, AgentResponse, AgentTask } from './types.js';

// 上下文管理
export { ContextCompressor } from './context/Compressor.js';
export { ContextManager } from './context/ContextManager.js';

// 创建Agent的便捷函数
export async function createAgent(
  config: import('./types.js').AgentConfig
): Promise<import('./Agent.js').Agent> {
  const { Agent } = await import('./Agent.js');
  const agent = new Agent(config);
  await agent.initialize();
  return agent;
}
