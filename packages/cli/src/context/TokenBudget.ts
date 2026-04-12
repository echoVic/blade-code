/**
 * TokenBudget — 递减收益检测
 *
 * 跟踪 LLM 续写模式，当检测到递减收益时建议停止：
 * - 连续 N 次续写（max output recovery）且每次增量很小
 * - Token 使用率接近预算上限
 */

export interface BudgetTracker {
  /** 总 token 预算（maxContextTokens） */
  budget: number;
  /** 当前已使用的 token */
  usage: number;
  /** 连续续写次数（max output recovery 触发的） */
  consecutiveContinuations: number;
  /** 上一次续写的 output token 增量 */
  lastOutputDelta: number;
  /** 是否是子代理（子代理不限制） */
  isSubagent: boolean;
}

const MIN_USEFUL_DELTA = 500; // 最小有用增量（token）
const MAX_CONSECUTIVE_CONTINUATIONS = 3; // 最大连续续写次数
const USAGE_THRESHOLD = 0.9; // 使用率阈值

/**
 * 检查是否应该继续生成
 * @returns 'continue' 继续 | 'stop' 停止（递减收益）
 */
export function checkTokenBudget(tracker: BudgetTracker): 'continue' | 'stop' {
  // 子代理不限制
  if (tracker.isSubagent) return 'continue';

  // 无预算信息时不限制
  if (!tracker.budget || tracker.budget <= 0) return 'continue';

  // 递减收益检测：连续多次续写且增量很小
  if (
    tracker.consecutiveContinuations >= MAX_CONSECUTIVE_CONTINUATIONS &&
    tracker.lastOutputDelta < MIN_USEFUL_DELTA
  ) {
    return 'stop';
  }

  // 使用率检测：接近预算上限
  if (tracker.usage / tracker.budget >= USAGE_THRESHOLD) {
    return 'stop';
  }

  return 'continue';
}

/**
 * 创建初始 BudgetTracker
 */
export function createBudgetTracker(opts: {
  budget: number;
  isSubagent?: boolean;
}): BudgetTracker {
  return {
    budget: opts.budget,
    usage: 0,
    consecutiveContinuations: 0,
    lastOutputDelta: 0,
    isSubagent: opts.isSubagent ?? false,
  };
}

/**
 * 记录一次 LLM 输出
 */
export function recordOutput(
  tracker: BudgetTracker,
  outputTokens: number,
  isContinuation: boolean
): BudgetTracker {
  return {
    ...tracker,
    usage: tracker.usage + outputTokens,
    lastOutputDelta: outputTokens,
    consecutiveContinuations: isContinuation
      ? tracker.consecutiveContinuations + 1
      : 0,
  };
}
