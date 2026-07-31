/**
 * completionPolicy — 完成策略检查
 *
 * 从 executeLoopGenerator 中提取的三个完成检查逻辑：
 * 1. checkOutputRecovery — finishReason === 'length' 时的恢复/截断判断
 * 2. checkIncompleteIntent — 检测 LLM "说了要做但没做"的模式
 * 3. checkStopHook — 执行 stop hook 并加超时保护
 * 4. checkRalphLoop — Spec 未完成任务时自动继续（Ralph Loop 模式）
 *
 * 所有函数返回 action descriptors，不执行副作用。
 */

import type { PermissionMode } from '../../config/index.js';
import { getCwd } from '../../utils/cwd.js';
import type { BudgetTracker } from '../../context/TokenBudget.js';
import { checkTokenBudget } from '../../context/TokenBudget.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.AGENT);

// ===== Output Recovery =====

const MAX_OUTPUT_RECOVERY_LIMIT = 3;

export type OutputRecoveryAction =
  | { action: 'recover' }
  | { action: 'truncated' }
  | { action: 'budget_stop' }
  | { action: 'none' };

/**
 * 检查是否需要 max-output-tokens 恢复。
 *
 * Bug fix: 当 finishReason === 'length' 且 recovery 次数已达上限时，
 * 返回 action: 'truncated' 而非静默放过（旧代码直接 fall-through）。
 */
export function checkOutputRecovery(
  finishReason: string | undefined,
  recoveryCount: number,
  budgetTracker: BudgetTracker
): OutputRecoveryAction {
  if (finishReason !== 'length') {
    return { action: 'none' };
  }

  if (recoveryCount >= MAX_OUTPUT_RECOVERY_LIMIT) {
    return { action: 'truncated' };
  }

  if (checkTokenBudget(budgetTracker) === 'stop') {
    logger.info('[Loop] Token budget: diminishing returns detected, skipping recovery');
    return { action: 'budget_stop' };
  }

  return { action: 'recover' };
}

export { MAX_OUTPUT_RECOVERY_LIMIT };

// ===== Incomplete Intent Detection =====

const INCOMPLETE_INTENT_PATTERNS = [
  /：\s*$/,
  /:\s*$/,
  /\.\.\.\s*$/,
  /让我(先|来|开始|查看|检查|修复)/,
  /Let me (first|start|check|look|fix)/i,
  /I('ll| will) (now |)(create|write|edit|update|modify|fix|add|implement)/i,
  /我(现在就|来|要)(创建|写入|编辑|修改|修复|添加|实现)/,
  /\d+\.\s+(First|Next|Then|Finally)/i,
];

const CODE_BLOCK_WITHOUT_TOOL_PATTERN = /```[\s\S]{50,}```/;

const RETRY_PROMPT =
  '请执行你提到的操作，不要只是描述。使用 Edit/Write/Bash 工具来实际修改文件。';

/** 最大重试次数 */
const MAX_INCOMPLETE_INTENT_RETRIES = 2;

export type IncompleteIntentAction =
  | { action: 'retry'; prompt: string }
  | { action: 'none' };

/**
 * 检测 LLM 是否表达了意图但未执行工具。
 *
 * Bug fixes:
 * 1. 用显式 retryCount 替代滑动窗口，避免远距离重触发
 * 2. 只检测尾部 200 字符，避免全文误匹配
 * 3. 排除 markdown code block 内的匹配
 */
export function checkIncompleteIntent(
  content: string | undefined,
  retryCount: number,
  hadToolCalls = true
): IncompleteIntentAction {
  if (!content || retryCount >= MAX_INCOMPLETE_INTENT_RETRIES) {
    return { action: 'none' };
  }

  // 检测：输出了代码块但没调用任何工具（说明模型想改代码但没用工具）
  if (!hadToolCalls && CODE_BLOCK_WITHOUT_TOOL_PATTERN.test(content)) {
    return { action: 'retry', prompt: RETRY_PROMPT };
  }

  // 只检测尾部 200 字符
  const tail = content.slice(-200);

  // 排除 markdown code block：如果尾部处于未闭合的代码块中，跳过检测
  const codeBlockMarkers = tail.match(/```/g);
  if (codeBlockMarkers && codeBlockMarkers.length % 2 !== 0) {
    return { action: 'none' };
  }

  const isIncompleteIntent = INCOMPLETE_INTENT_PATTERNS.some((p) => p.test(tail));

  if (isIncompleteIntent) {
    return { action: 'retry', prompt: RETRY_PROMPT };
  }

  return { action: 'none' };
}

export { RETRY_PROMPT, MAX_INCOMPLETE_INTENT_RETRIES };

// ===== Stop Hook =====

const STOP_HOOK_TIMEOUT = 30_000;

export type StopHookAction =
  | { action: 'stop' }
  | { action: 'continue'; reason?: string };

/**
 * 执行 stop hook 并加超时保护。
 *
 * Bug fix: 为 stop hook 增加 Promise.race + timeout(30s)，
 * 超时按 shouldStop: true 处理并打 warning。
 */
export async function checkStopHook(context: {
  sessionId: string;
  permissionMode: PermissionMode;
  reason?: string;
  abortSignal?: AbortSignal;
}): Promise<StopHookAction> {
  try {
    const hookManager = HookManager.getInstance();

    const hookPromise = hookManager.executeStopHooks({
      projectDir: getCwd(),
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      reason: context.reason,
      abortSignal: context.abortSignal,
    });

    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), STOP_HOOK_TIMEOUT);
    });

    try {
      const raceResult = await Promise.race([hookPromise, timeoutPromise]);

      if (raceResult === 'timeout') {
        logger.warn(
          `[Loop] Stop hook 超时 (${STOP_HOOK_TIMEOUT}ms)，按 shouldStop: true 处理`
        );
        return { action: 'stop' };
      }

      const stopResult = raceResult;
      if (!stopResult.shouldStop) {
        return {
          action: 'continue',
          reason: stopResult.continueReason,
        };
      }

      return { action: 'stop' };
    } finally {
      clearTimeout(timerId!);
    }
  } catch (hookError) {
    logger.warn('[Loop] Stop hook execution failed:', hookError);
    // hook 执行失败时按 stop 处理（保守策略）
    return { action: 'stop' };
  }
}

// ===== Ralph Loop (Spec-Aware Auto-Continue) =====

/** Ralph Loop 安全阈值：当轮次超过最大轮次的 90% 时停止，防止无限循环 */
const RALPH_LOOP_SAFETY_RATIO = 0.9;

export type RalphLoopAction =
  | { action: 'continue'; reason: string }
  | { action: 'none' };

/**
 * Ralph Loop：当 Spec 处于 implementation 阶段且有未完成任务时，
 * 自动继续执行而不停止。
 *
 * 触发条件（全部满足）：
 * 1. Spec 模式活跃且处于 implementation 阶段
 * 2. 存在未完成任务
 * 3. 轮次未超出安全阈值（防止无限循环）
 */
export async function checkRalphLoop(context: {
  turnsCount: number;
  maxTurns: number;
}): Promise<RalphLoopAction> {
  try {
    // 延迟导入避免循环依赖
    const { SpecManager } = await import('../../spec/SpecManager.js');
    const specManager = SpecManager.getInstance();

    if (!specManager.isActive()) {
      return { action: 'none' };
    }

    const spec = specManager.getCurrentSpec();
    if (!spec || spec.phase !== 'implementation') {
      return { action: 'none' };
    }

    // 安全阈值检查
    if (
      context.maxTurns > 0 &&
      context.turnsCount >= context.maxTurns * RALPH_LOOP_SAFETY_RATIO
    ) {
      logger.info(
        `[RalphLoop] 轮次接近上限 (${context.turnsCount}/${context.maxTurns})，停止自动继续`
      );
      return { action: 'none' };
    }

    const tasks = spec.tasks ?? [];
    const completed = tasks.filter(
      (t: { status: string }) => t.status === 'completed' || t.status === 'skipped'
    ).length;
    const total = tasks.length;

    if (completed >= total) {
      return { action: 'none' };
    }

    // 找到下一个待执行任务
    const nextTask = tasks.find(
      (t: { status: string }) => t.status === 'pending' || t.status === 'in_progress'
    );

    const reason =
      `[Ralph Loop] Spec "${spec.name}" 仍有未完成任务。\n` +
      `进度: ${completed}/${total} 任务已完成。\n` +
      (nextTask
        ? `下一个任务: ${nextTask.title}${nextTask.description ? ` — ${nextTask.description}` : ''}\n`
        : '') +
      '请继续执行下一个未完成的任务，不要停止。';

    logger.info(`[RalphLoop] Spec "${spec.name}" 进度 ${completed}/${total}，自动继续`);
    return { action: 'continue', reason };
  } catch {
    // SpecManager 不可用时（如未初始化），静默跳过
    return { action: 'none' };
  }
}
