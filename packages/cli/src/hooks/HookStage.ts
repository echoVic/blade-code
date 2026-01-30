/**
 * Hook Stage for ExecutionPipeline
 *
 * 在权限阶段之后执行 PreToolUse hooks
 */

import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import type { PipelineStage, ToolExecution } from '../tools/types/index.js';
import { HookManager } from './HookManager.js';

/**
 * Hook 阶段
 *
 * 插入到 Permission 和 Confirmation 之间:
 * Discovery → Permission → **Hook** → Confirmation → Execution → Formatting
 */
export class HookStage implements PipelineStage {
  readonly name = 'hook';

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

    // 执行 PreToolUse hooks
    try {
      // 生成唯一的 toolUseId (优先使用 messageId，否则生成 nanoid)
      // 存储到 _internal 以便 PostToolUse 阶段复用
      const toolUseId = execution.context.messageId || `tool_${nanoid()}`;
      execution._internal.hookToolUseId = toolUseId;

      const projectDir = execution.context.workspaceRoot || process.cwd();

      const result = await this.hookManager.executePreToolHooks(
        tool.name,
        toolUseId,
        execution.params as Record<string, unknown>,
        {
          projectDir,
          sessionId: execution.context.sessionId || 'unknown',
          permissionMode: execution.context.permissionMode ?? PermissionMode.DEFAULT,
          abortSignal: execution.context.signal,
        }
      );

      // 处理 Hook 决策
      if (result.decision === 'deny') {
        execution.abort(result.reason || 'Hook blocked execution');
        return;
      }

      if (result.decision === 'ask') {
        // 标记需要用户确认
        execution._internal.needsConfirmation = true;
        execution._internal.confirmationReason =
          result.reason || 'Hook requires confirmation';
        return;
      }

      // 应用修改后的输入
      if (result.modifiedInput) {
        // 创建新的params对象
        const newParams = {
          ...execution.params,
          ...result.modifiedInput,
        };

        // 需要重新验证参数
        if (tool.build) {
          try {
            tool.build(newParams);
            // 验证通过,更新params (通过内部接口)
            (execution as unknown as { params: Record<string, unknown> }).params =
              newParams;
          } catch (err) {
            execution.abort(
              `Hook modified parameters are invalid: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
          }
        }
      }

      // 警告信息
      if (result.warning) {
        console.warn(`[Hook Warning] ${result.warning}`);
      }
    } catch (err) {
      // Hook 执行失败,根据配置决定是否继续
      console.error('[HookStage] Error executing hooks:', err);

      // 可以考虑添加配置控制是否在 hook 失败时中止
      // 目前默认继续执行
    }
  }
}
