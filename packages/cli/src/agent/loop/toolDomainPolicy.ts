/**
 * toolDomainPolicy — 工具结果的领域副作用处理
 *
 * 从 executeLoopGenerator 中提取的 domain side effects：
 * - TodoWrite → 更新 todo 列表
 * - Skill → 激活 skill context
 * - ModelSwitch → 触发模型切换
 *
 * 纯函数 / 薄封装，返回 action descriptors 或直接调用 deps 回调。
 */

import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { LoopDependencies } from './types.js';

/**
 * 窄化的工具调用引用：只包含 function 类型的 tool call。
 * 由调用方在传入时断言（executeLoopGenerator 中已有此 cast）。
 */
export interface FunctionToolCallRef {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ===== TodoWrite =====

export interface TodoUpdateAction {
  kind: 'todo_update';
  todos: TodoItem[];
}

/**
 * 处理 TodoWrite 工具结果，提取 todo 列表。
 * 返回 TodoUpdateAction 或 null。
 */
export function handleTodoWrite(
  toolCall: FunctionToolCallRef,
  result: ToolResult,
): TodoUpdateAction | null {
  if (
    toolCall.function.name !== 'TodoWrite' ||
    !result.success ||
    !result.llmContent
  ) {
    return null;
  }

  const content =
    typeof result.llmContent === 'object' ? result.llmContent : {};
  const todos = Array.isArray(content)
    ? content
    : ((content as Record<string, unknown>).todos as unknown[]) || [];

  return {
    kind: 'todo_update',
    todos: todos as TodoItem[],
  };
}

// ===== Skill Activation =====

/**
 * 处理 Skill 工具结果，触发 skill 激活回调。
 */
export function handleSkillActivation(
  toolCall: FunctionToolCallRef,
  result: ToolResult,
  deps: LoopDependencies,
): void {
  if (
    toolCall.function.name !== 'Skill' ||
    !result.success ||
    !result.metadata
  ) {
    return;
  }

  const metadata = result.metadata as Record<string, unknown>;
  if (metadata.skillName) {
    deps.onSkillActivated?.({
      skillName: metadata.skillName as string,
      allowedTools: metadata.allowedTools as string[] | undefined,
      basePath: (metadata.basePath as string) || '',
    });
  }
}

// ===== Model Switch =====

/**
 * 处理工具结果中的模型切换请求。
 * 返回 modelId 或 undefined。
 */
export function extractModelSwitch(
  result: ToolResult,
): string | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (!metadata) return undefined;

  const modelId =
    metadata.modelId?.toString().trim() ||
    metadata.model?.toString().trim() ||
    undefined;

  return modelId || undefined;
}

/**
 * 处理所有工具结果的领域副作用。
 * 返回 TodoUpdateAction（如果有）并触发 skill/model 回调。
 */
export async function applyToolDomainEffects(
  toolCall: FunctionToolCallRef,
  result: ToolResult,
  deps: LoopDependencies,
): Promise<TodoUpdateAction | null> {
  // TodoWrite
  const todoAction = handleTodoWrite(toolCall, result);

  // Skill activation
  handleSkillActivation(toolCall, result, deps);

  // Model switch
  const modelId = extractModelSwitch(result);
  if (modelId) {
    await deps.onModelSwitch?.(modelId);
  }

  return todoAction;
}
