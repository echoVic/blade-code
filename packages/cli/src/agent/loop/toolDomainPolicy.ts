/**
 * toolDomainPolicy — 工具结果的领域副作用处理
 *
 * 从 executeLoopGenerator 中提取的 domain side effects：
 * - TaskCreate/TaskUpdate/TaskList -> 更新任务列表
 * - Skill -> 激活 skill context
 * - ModelSwitch -> 触发模型切换
 *
 * 纯函数 / 薄封装，返回 action descriptors 或直接调用 deps 回调。
 */

import type { TaskListItem } from '../../tools/builtin/task/taskListTypes.js';
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

// ===== Task list updates =====

export interface TaskUpdateAction {
  kind: 'task_update';
  tasks: TaskListItem[];
}

/**
 * 处理任务列表工具结果，提取任务列表。
 * 返回 TaskUpdateAction 或 null。
 */
export function handleTaskListUpdate(
  toolCall: FunctionToolCallRef,
  result: ToolResult
): TaskUpdateAction | null {
  if (
    !['TaskCreate', 'TaskUpdate', 'TaskList'].includes(toolCall.function.name) ||
    !result.success ||
    (!result.llmContent && !result.metadata)
  ) {
    return null;
  }

  const content = typeof result.llmContent === 'object' ? result.llmContent : {};
  const rawTasks =
    ((result.metadata as Record<string, unknown> | undefined)?.tasks as unknown[]) ||
    ((content as Record<string, unknown>).tasks as unknown[]) ||
    [];

  return {
    kind: 'task_update',
    tasks: rawTasks as TaskListItem[],
  };
}

// ===== Skill Activation =====

/**
 * 处理 Skill 工具结果，触发 skill 激活回调。
 */
export function handleSkillActivation(
  toolCall: FunctionToolCallRef,
  result: ToolResult,
  deps: LoopDependencies
): void {
  if (toolCall.function.name !== 'Skill' || !result.success || !result.metadata) {
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
export function extractModelSwitch(result: ToolResult): string | undefined {
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
 * 返回 TaskUpdateAction（如果有）并触发 skill/model 回调。
 */
export async function applyToolDomainEffects(
  toolCall: FunctionToolCallRef,
  result: ToolResult,
  deps: LoopDependencies
): Promise<TaskUpdateAction | null> {
  // Task list updates
  const taskAction = handleTaskListUpdate(toolCall, result);

  // Skill activation
  handleSkillActivation(toolCall, result, deps);

  // Model switch
  const modelId = extractModelSwitch(result);
  if (modelId) {
    await deps.onModelSwitch?.(modelId);
  }

  return taskAction;
}
