/**
 * @blade-ai/core 包公共 API - 简化架构
 */

// Agent核心系统
export { Agent } from './agent/Agent.js';
export { ExecutionEngine } from './agent/ExecutionEngine.js';
export type { AgentConfig, AgentResponse, AgentTask } from './agent/types.js';

// Chat服务 (统一的LLM接口)
export { ChatService } from './services/ChatService.js';
export type { ChatConfig, ChatResponse, Message } from './services/ChatService.js';

// 工具系统
export { ToolManager } from './tools/ToolManager.js';
export type { Tool, ToolExecutionResult, ToolManagerConfig } from './tools/types.js';

// 配置管理 (简化版)
export { ConfigManager } from './config/ConfigManager.js';

// 核心服务
export { ChatService as LLMService } from './services/ChatService.js';

// 版本信息
export const VERSION = '1.3.0';
