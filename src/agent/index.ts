/**
 * Agent模块导出 - 简化架构
 */

export { ContextManager } from '../context/ContextManager.js';
// 上下文管理
export { ContextCompressor } from '../context/processors/ContextCompressor.js';
// 核心Agent类
export { Agent } from './Agent.js';
// Agent创建函数
export { createAgent, type AgentOptions } from './agent-creator.js';
export type { AgentConfig, AgentResponse, AgentTask } from './types.js';
