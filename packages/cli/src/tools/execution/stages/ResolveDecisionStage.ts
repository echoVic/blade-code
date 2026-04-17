import { createLogger, LogCategory } from '../../../logging/Logger.js';
import type {
  PermissionDecision,
  PipelineStage,
  ToolExecution,
} from '../../types/index.js';

const logger = createLogger(LogCategory.EXECUTION);

/**
 * 决策仲裁阶段
 *
 * 合并 RuleBasedPermissionStage 的 ruleDecision 与 PreToolUseHookStage 的 hookDecision,
 * 产出最终 effectiveDecision。
 *
 * 硬不变量: Hook 只能收紧规则库,不能放宽。
 *
 *   Rule \ Hook   | deny | ask      | allow | (none)
 *   --------------|------|----------|-------|--------
 *   deny          | deny | deny     | deny  | deny
 *   ask           | deny | ask[hook]| ask   | ask
 *   allow         | deny | ask[hook]| allow | allow
 *   (none=ask)    | deny | ask[hook]| allow | ask
 *
 * 说明:
 * - "ask[hook]" 表示两侧均要求确认时,优先保留 Hook 的 reason (通常包含
 *   场景化上下文,如"修改生产配置"),规则库的 generic reason 被覆盖。
 * - Hook 只能收紧规则库,不能放宽 (rule=ask + hook=allow 仍为 ask)。
 *
 * 若最终 behavior=deny, 本阶段直接 abort; 若 ask, 由 ConfirmationStage 处理。
 */
export class ResolveDecisionStage implements PipelineStage {
  readonly name = 'resolve-decision';

  async process(execution: ToolExecution): Promise<void> {
    const { ruleDecision, hookDecision } = execution._internal;
    const effective = ResolveDecisionStage.resolve(ruleDecision, hookDecision);
    execution._internal.effectiveDecision = effective;

    logger.debug(
      `[ResolveDecision] rule=${ruleDecision?.behavior ?? 'none'} ` +
        `hook=${hookDecision?.behavior ?? 'none'} → ${effective.behavior} ` +
        `(${effective.source})`
    );

    if (effective.behavior === 'deny') {
      execution.abort(
        effective.reason ||
          `Tool invocation denied by ${effective.source}${
            effective.matchedRule ? ` (${effective.matchedRule})` : ''
          }`
      );
    }
    // ask/allow 由 ConfirmationStage 基于 effectiveDecision 处理
  }

  /**
   * 纯函数仲裁逻辑 (可独立测试)
   */
  static resolve(
    rule: PermissionDecision | undefined,
    hook: PermissionDecision | undefined
  ): PermissionDecision {
    // 1. 任一方 deny → deny (rule 优先作为来源,否则 hook)
    if (rule?.behavior === 'deny') return rule;
    if (hook?.behavior === 'deny') return hook;

    // 2. Hook ask → ask (Hook 的 reason 通常包含场景化上下文,优先展示)
    //    注意: rule=ask + hook=allow 不会走到这里 (hook 不是 ask),
    //    会在下一步 fallback 到 rule.ask,硬不变量保持。
    if (hook?.behavior === 'ask') return hook;

    // 3. 规则库 ask → ask (Hook 未表态或 hook=allow 时保留规则的 ask)
    if (rule?.behavior === 'ask') return rule;

    // 4. 规则库 allow → allow
    if (rule?.behavior === 'allow') return rule;

    // 5. 仅 hook allow → allow
    if (hook?.behavior === 'allow') return hook;

    // 6. 兜底: 保守 ask
    return {
      behavior: 'ask',
      source: 'default',
      reason: 'No permission rule or hook decision; defaulting to ask',
    };
  }
}
