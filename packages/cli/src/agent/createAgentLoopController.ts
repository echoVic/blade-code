import type { TodoItem } from '../tools/builtin/todo/types.js';
import type { FunctionDeclaration } from '../tools/types/index.js';
import type { AgentSkillContextController } from './agentSkillContextController.js';

export interface AgentLoopController {
  applySkillToolRestrictions(
    tools: FunctionDeclaration[]
  ): FunctionDeclaration[];
  activateSkillContext(metadata: Record<string, unknown>): void;
  switchModelIfNeeded(modelId: string): Promise<void>;
  setTodos(todos: TodoItem[]): void;
  log(message: string): void;
  error(message: string): void;
}

export function createAgentLoopController({
  skillContextController,
  switchModelIfNeeded,
  setTodos,
  log,
  error,
}: {
  skillContextController: Pick<
    AgentSkillContextController,
    'applyToolRestrictions' | 'activateSkillContext'
  >;
  switchModelIfNeeded(modelId: string): Promise<void>;
  setTodos(todos: TodoItem[]): void;
  log(message: string): void;
  error(message: string): void;
}): AgentLoopController {
  return {
    applySkillToolRestrictions: (tools) =>
      skillContextController.applyToolRestrictions(tools),
    activateSkillContext: (metadata) =>
      skillContextController.activateSkillContext(metadata),
    switchModelIfNeeded,
    setTodos,
    log,
    error,
  };
}
