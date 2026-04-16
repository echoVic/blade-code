/**
 * Abort Reason 语义化类型
 *
 * 区分不同的 abort 来源，让下游代码根据 reason 做不同处理。
 * 例如 interrupt 不显示"任务已停止"，而 user-cancel 显示。
 */

/**
 * 已知的 abort reason 类型：
 * - 'user-cancel'   — 用户按 Esc 取消
 * - 'interrupt'     — 用户运行中提交新消息，中断当前任务
 * - 'sibling-error' — 同级工具执行出错导致 abort
 * - 'timeout'       — 超时
 */
export type AbortReason = 'user-cancel' | 'interrupt' | 'sibling-error' | 'timeout';

const VALID_REASONS = new Set<string>(['user-cancel', 'interrupt', 'sibling-error', 'timeout']);

/**
 * 从 AbortSignal 中提取 reason。
 * - 如果 signal 未 aborted，返回 undefined
 * - 如果 reason 是已知类型，返回对应类型
 * - 否则兼容回退到 'user-cancel'
 */
export function getAbortReason(signal: AbortSignal): AbortReason | undefined {
  if (!signal.aborted) return undefined;
  if (typeof signal.reason === 'string' && VALID_REASONS.has(signal.reason)) {
    return signal.reason as AbortReason;
  }
  return 'user-cancel'; // 兼容不传 reason 的旧调用
}
