/**
 * Agent Loop 模块
 *
 * 提供 AsyncGenerator 驱动的 Agent 循环实现
 */

export { ConversationState, isRootSystemPrompt } from './ConversationState.js';
export { drainLoop } from './consumeLoop.js';
export {
  checkOutputRecovery,
  checkIncompleteIntent,
  checkStopHook,
} from './completionPolicy.js';
export {
  saveUserMessage,
  saveAssistantMessage,
  saveToolUse,
  saveToolResult,
  saveCompaction,
} from './conversationPersistence.js';
export {
  applyToolDomainEffects,
  handleTaskListUpdate,
  handleSkillActivation,
  extractModelSwitch,
} from './toolDomainPolicy.js';
export type { FunctionToolCallRef, TaskUpdateAction } from './toolDomainPolicy.js';
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
