import type { BladeConfig } from '../config/index.js';
import type {
  ChatResponse,
  IChatService,
  Message,
} from '../services/ChatServiceInterface.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type { FunctionDeclaration } from '../tools/types/index.js';
import type {
  LoopExecutionEngine,
  LoopExecutionPipeline,
} from './loopRuntimeTypes.js';
import type {
  AgentOptions,
  ChatContext,
  LoopOptions,
} from './types.js';

export interface AgentLoopDependencies {
  config: BladeConfig;
  runtimeOptions: AgentOptions;
  currentModelMaxContextTokens: number;
  executionPipeline: LoopExecutionPipeline;
  executionEngine?: LoopExecutionEngine;
  chatService: IChatService;
  applySkillToolRestrictions(
    tools: FunctionDeclaration[]
  ): FunctionDeclaration[];
  processStreamResponse(
    messages: Message[],
    tools: FunctionDeclaration[],
    options?: LoopOptions
  ): Promise<ChatResponse>;
  checkAndCompactInLoop(
    context: ChatContext,
    currentTurn: number,
    actualPromptTokens?: number,
    onCompacting?: (isCompacting: boolean) => void
  ): Promise<boolean>;
  switchModelIfNeeded(modelId: string): Promise<void>;
  activateSkillContext(metadata: Record<string, unknown>): void;
  setTodos(todos: TodoItem[]): void;
  log(message: string): void;
  error(message: string): void;
}

export type AgentLoopRuntimeState = Pick<
  AgentLoopDependencies,
  | 'config'
  | 'runtimeOptions'
  | 'currentModelMaxContextTokens'
  | 'executionPipeline'
  | 'executionEngine'
  | 'chatService'
>;

export type AgentLoopRuntimeInitDependencies = Pick<
  AgentLoopDependencies,
  'config' | 'runtimeOptions' | 'executionPipeline' | 'applySkillToolRestrictions'
>;

export type AgentLoopTurnDependencies = Pick<
  AgentLoopDependencies,
  | 'currentModelMaxContextTokens'
  | 'processStreamResponse'
  | 'chatService'
  | 'executionPipeline'
  | 'executionEngine'
  | 'activateSkillContext'
  | 'switchModelIfNeeded'
  | 'setTodos'
  | 'log'
  | 'error'
>;

export type AgentLoopIterationDependencies = Pick<
  AgentLoopDependencies,
  | 'config'
  | 'currentModelMaxContextTokens'
  | 'executionPipeline'
  | 'executionEngine'
  | 'chatService'
  | 'processStreamResponse'
  | 'checkAndCompactInLoop'
  | 'switchModelIfNeeded'
  | 'activateSkillContext'
  | 'setTodos'
  | 'log'
  | 'error'
>;
