/**
 * Agent Loop 模块
 *
 * 提供 AsyncGenerator 驱动的 Agent 循环实现
 */

export { drainLoop } from './consumeLoop.js';
export { executeLoopGenerator, checkAndCompactInLoop } from './executeLoopGenerator.js';
export { StreamingToolExecutor } from './StreamingToolExecutor.js';

export type {
  FunctionDeclaration,
  LoopDependencies,
  LoopEvent,
  LoopPhase,
  LoopState,
  SkillExecutionContext,
  TokenUsageInfo,
  ToolCallRef,
  ToolExecResult,
  ToolKindStr,
} from './types.js';
