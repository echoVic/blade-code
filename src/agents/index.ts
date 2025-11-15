/**
 * Blade Subagent System
 *
 * Public API for the subagent system
 */

// Re-export from tools types
export type { ConfirmationHandler, ExecutionContext } from '../tools/types/index.js';
// Confirmation Handler
export {
  createConfirmationHandler,
  getReadOnlyTools,
  getWriteTools,
  isReadOnlyTool,
  isWriteTool,
  WriteToolConfirmationHandler,
} from './confirmation.js';
// Executor
export {
  createExecutor,
  SubagentExecutor,
  type SubagentExecutionContext,
} from './executor.js';

// Parser
export { createParser, SubagentConfigParser } from './parser.js';

// Registry
export {
  getRegistry,
  initializeRegistry,
  SubagentRegistry,
} from './registry.js';
// Task Manager
export { createTaskManager, SubagentTaskManager } from './taskManager.js';
export type {
  JSONSchema,
  PersistedTask,
  SubagentActivity,
  SubagentConfig,
  SubagentDefinition,
  SubagentResult,
  TaskStatus,
  TokenUsage,
} from './types.js';
// Types
export {
  ConcurrentLimitError,
  ConfigParseError,
  TerminateReason,
  TokenBudgetExceededError,
} from './types.js';
