import type { PermissionMode } from '../config/types.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { JsonValue } from '../store/types.js';
import type { FunctionDeclaration, ToolResult } from '../tools/types/index.js';
import type { ChatContext } from './types.js';

export interface LoopRegistry {
  getFunctionDeclarationsByMode(permissionMode?: PermissionMode): FunctionDeclaration[];
  getReadOnlyTools(): Array<{ name: string }>;
  get(name: string): { kind?: 'readonly' | 'write' | 'execute' } | undefined;
}

export interface LoopContextManager {
  saveMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    previousId: string | null,
    metadata?: unknown,
    subagentInfo?: ChatContext['subagentInfo']
  ): Promise<string | null>;
  saveToolUse(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
    previousId: string | null,
    subagentInfo?: ChatContext['subagentInfo']
  ): Promise<string | null>;
  saveToolResult(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    llmContent: JsonValue | null,
    toolUseUuid: string | null,
    error?: string,
    subagentInfo?: ChatContext['subagentInfo'],
    subagentRef?: Record<string, unknown>
  ): Promise<string | null>;
  saveCompaction(
    sessionId: string,
    summary: string,
    metadata: Record<string, unknown>,
    previousId: string | null
  ): Promise<string>;
}

export interface LoopExecutionEngine {
  getContextManager(): LoopContextManager | undefined;
}

export interface LoopExecutionPipeline {
  getRegistry(): LoopRegistry;
  execute(
    toolName: string,
    params: Record<string, unknown>,
    context: {
      sessionId?: string;
      userId?: string;
      workspaceRoot?: string;
      signal?: AbortSignal;
      confirmationHandler?: ChatContext['confirmationHandler'];
      permissionMode?: ChatContext['permissionMode'];
    }
  ): Promise<ToolResult>;
}

export type LoopLookupRegistry = Pick<LoopRegistry, 'get'>;

export type LoopMessageExecutionEngine = {
  getContextManager(): Pick<LoopContextManager, 'saveMessage'> | undefined;
};

export type LoopToolUseExecutionEngine = {
  getContextManager(): Pick<LoopContextManager, 'saveToolUse'> | undefined;
};

export type LoopToolResultExecutionEngine = {
  getContextManager(): Pick<LoopContextManager, 'saveToolResult'> | undefined;
};

export type LoopCompactionExecutionEngine = {
  getContextManager(): Pick<LoopContextManager, 'saveCompaction'> | undefined;
};

export type LoopToolExecutionPipeline = Pick<LoopExecutionPipeline, 'execute'>;

export interface LoopConversationInitResult {
  messages: Message[];
  lastMessageUuid: string | null;
  prependedSystemPrompt: boolean;
}
