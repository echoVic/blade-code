/**
 * Agent模块导出 - 简化架构
 */

export { ContextManager } from '../context/ContextManager.js';
// 上下文管理
export { ContextCompressor } from '../context/processors/ContextCompressor.js';
// 核心Agent类
export { Agent } from './Agent.js';
export type {
  AgentOptions,
  AgentResponse,
  AgentTask,
  ChatContext,
} from './types.js';
