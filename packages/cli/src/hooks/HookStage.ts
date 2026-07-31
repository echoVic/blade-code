/**
 * PreToolUse Hook Stage
 *
 * 插入位置: RuleBasedPermission -> **Hook(Pre)** -> ResolveDecision -> Confirmation -> ...
 *
 * 本阶段职责:
 * 1. 调用 PreToolUse hooks 获取用户 Hook 的决策
 * 2. 将决策写入 execution._internal.hookDecision (供 ResolveDecisionStage 仲裁)
 * 3. 应用 Hook 返回的 modifiedInput (需通过 Zod 重新验证)
 *
 * 不做:
 * - 不直接 abort (deny 交给 ResolveDecisionStage 仲裁)
 * - 不直接设置 needsConfirmation (ask 交给 ResolveDecisionStage 派生)
 *
 * 硬不变量: Hook 不能覆盖规则库的 deny/ask。参考 ResolveDecisionStage.resolve。
 */

import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import type {
  PermissionBehavior,
  PermissionDecision,
  PipelineStage,
  ToolExecution,
} from '../tools/types/index.js';
import { getCwd } from '../utils/cwd.js';
import { HookManager } from './HookManager.js';

export class HookStage implements PipelineStage {
  readonly name = 'hook';

  private hookManager: HookManager;

  constructor() {
    this.hookManager = HookManager.getInstance();
  }

  async process(execution: ToolExecution): Promise<void> {
    if (!this.hookManager.isEnabled()) return;

    const tool = execution._internal.tool;
    if (!tool) return;

    // 短路优化: 规则库已判 deny → 无需跑 Hook
    if (execution._internal.ruleDecision?.behavior === 'deny') return;

    try {
      const toolUseId = execution.context.messageId || `tool_${nanoid()}`;
      execution._internal.hookToolUseId = toolUseId;

      const projectDir = execution.context.workspaceRoot || getCwd();

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

      // 参数修改: 需重新 Zod 验证 (即使 Hook 决策是 deny 也不应修改)
      if (result.modifiedInput && result.decision !== 'deny') {
        const newParams = {
          ...execution.params,
          ...result.modifiedInput,
        };
        try {
          tool.build(newParams);
          (execution as unknown as { params: Record<string, unknown> }).params =
            newParams;
        } catch (err) {
          execution.abort(
            `Hook modified parameters are invalid: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return;
        }
      }

      // 产出 hookDecision (供 ResolveDecisionStage 仲裁)
      execution._internal.hookDecision = toPermissionDecision(result.decision, {
        reason: result.reason,
      });

      if (result.warning) {
        console.warn(`[Hook Warning] ${result.warning}`);
      }
    } catch (err) {
      console.error('[HookStage] Error executing hooks:', err);
      // Hook 执行异常不阻断流程; hookDecision 保持缺席,由规则库决策
    }
  }
}

function toPermissionDecision(
  decision: PermissionBehavior,
  extra: { reason?: string }
): PermissionDecision {
  return {
    behavior: decision,
    source: 'hook',
    reason: extra.reason,
  };
}
