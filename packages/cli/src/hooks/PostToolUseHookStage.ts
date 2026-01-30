/**
 * PostToolUse Hook Stage for ExecutionPipeline
 *
 * 在工具执行之后执行 PostToolUse hooks
 */

import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import type { PipelineStage, ToolExecution } from '../tools/types/index.js';
import { HookManager } from './HookManager.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * PostToolUse Hook 阶段
 *
 * 插入到 Execution 和 Formatting 之间:
 * Discovery → Permission → Hook(Pre) → Confirmation → Execution → **PostHook** → Formatting
 */
export class PostToolUseHookStage implements PipelineStage {
  readonly name = 'post-hook';

  private hookManager: HookManager;

  constructor() {
    this.hookManager = HookManager.getInstance();
  }

  async process(execution: ToolExecution): Promise<void> {
    // 跳过条件
    if (!this.hookManager.isEnabled()) {
      return;
    }

    const tool = execution._internal.tool;
    if (!tool) {
      return;
    }

    // 只有在工具成功执行后才运行 PostToolUse hooks
    const result = execution.getResult();
    if (!result) {
      return;
    }

    // 执行 PostToolUse hooks
    try {
      // 复用 PreToolUse 阶段生成的 toolUseId，确保 Pre/Post 事件可以关联
      // 如果 PreToolUse 被跳过（hooks 未启用），则回退到 messageId 或生成新 ID
      const toolUseId =
        execution._internal.hookToolUseId ||
        execution.context.messageId ||
        `tool_${nanoid()}`;
      const projectDir = execution.context.workspaceRoot || process.cwd();

      const hookResult = await this.hookManager.executePostToolHooks(
        tool.name,
        toolUseId,
        execution.params as Record<string, unknown>,
        result,
        {
          projectDir,
          sessionId: execution.context.sessionId || 'unknown',
          permissionMode: execution.context.permissionMode ?? PermissionMode.DEFAULT,
          abortSignal: execution.context.signal,
        }
      );

      // 处理 Hook 结果
      // 1. 添加额外上下文给 LLM
      if (hookResult.additionalContext) {
        // 将额外上下文添加到 result.llmContent
        const currentContent = result.llmContent || result.displayContent || '';
        result.llmContent = `${currentContent}\n\n---\n**Hook Context:**\n${hookResult.additionalContext}`;
      }

      // 2. 修改工具输出（如果 hook 返回了 modifiedOutput）
      if (hookResult.modifiedOutput !== undefined) {
        // 使用 hook 修改后的输出替换原输出
        const modifiedResult = hookResult.modifiedOutput;
        if (isRecord(modifiedResult)) {
          Object.assign(result, modifiedResult);
        }
      }

      // 3. 警告信息
      if (hookResult.warning) {
        console.warn(`[PostToolUseHook Warning] ${hookResult.warning}`);
      }
    } catch (err) {
      // PostToolUse hook 失败不应该阻止工具结果返回
      // 只记录错误，继续执行
      console.error('[PostToolUseHookStage] Error executing post-tool hooks:', err);
    }
  }
}
