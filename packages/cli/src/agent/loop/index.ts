/**
 * Agent Loop 模块
 *
 * 提供 AsyncGenerator 驱动的 Agent 循环实现
 */

export { drainLoop } from './consumeLoop.js';
export { checkAndCompactInLoop, executeLoopGenerator } from './executeLoopGenerator.js';
export type { CompactResult } from './executeLoopGenerator.js';
export { StreamingToolExecutor } from './StreamingToolExecutor.js';

export type {
  DomainEvent,
  FunctionDeclaration,
  LoopDependencies,
  LoopEvent,
  LoopPhase,
  LoopState,
  SkillExecutionContext,
  StreamEvent,
  SystemEvent,
  TokenUsageInfo,
  ToolCallRef,
  ToolEvent,
  ToolExecResult,
  ToolKindStr
} from './types.js';

