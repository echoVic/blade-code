/**
 * Abort 信号工具集
 *
 * 提供 AbortController/AbortSignal 的组合与传播工具，
 * 从 StreamingToolExecutor 中提取并增强。
 */

import { isAbortReason } from './abortReason.js';

/**
 * 判断一个 error 是否为 AbortError（宽口径）。
 * 覆盖 DOMException('AbortError')、普通 Error name='AbortError'、以及 message 含 'aborted' 的情况。
 * 与 executeLoopGenerator 外层 catch 的判断逻辑一致。
 */
export function isAbortError(error: unknown): boolean {
  if (isAbortReason(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error.message.includes('aborted')) return true;
  return false;
}

/**
 * 创建一个子 AbortController，当父 signal abort 时子也 abort（单向传播）。
 * - 父已 aborted → 子立即 abort（快速路径）
 * - 子 abort 时自动从父移除 listener，防止内存泄漏
 * - 传播 abort reason
 */
export function createChildAbortController(parentSignal: AbortSignal): AbortController {
  const child = new AbortController();

  // 快速路径：父已 aborted
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }

  const onParentAbort = () => {
    child.abort(parentSignal.reason);
  };

  parentSignal.addEventListener('abort', onParentAbort, { once: true });

  // 子 abort 时清理父上的 listener
  child.signal.addEventListener(
    'abort',
    () => {
      parentSignal.removeEventListener('abort', onParentAbort);
    },
    { once: true }
  );

  return child;
}

/**
 * 合并多个 AbortSignal — 任一触发则合并后的 signal 也触发。
 * 修复了旧实现中 fallback 分支丢失 reason 的问题。
 *
 * @returns 合并后的 AbortSignal
 */
export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // 过滤 undefined/null
  const validSignals = signals.filter(Boolean);
  if (validSignals.length === 0) return new AbortController().signal;
  if (validSignals.length === 1) return validSignals[0];

  // 优先使用 AbortSignal.any（Node 20+）
  const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof abortSignalWithAny.any === 'function') {
    return abortSignalWithAny.any(validSignals);
  }

  // Fallback: 手动合并，修复 reason 传播
  for (const s of validSignals) {
    if (s.aborted) return s;
  }

  const controller = new AbortController();
  // 保存 bound 引用，确保 addEventListener/removeEventListener 使用同一函数对象
  const boundHandlers = new Map<AbortSignal, () => void>();
  for (const s of validSignals) {
    const handler = () => {
      controller.abort(s.reason);
      // 清理所有 listener，防止泄漏
      for (const [sig, h] of boundHandlers) {
        sig.removeEventListener('abort', h);
      }
    };
    boundHandlers.set(s, handler);
  }
  for (const [s, handler] of boundHandlers) {
    s.addEventListener('abort', handler, { once: true });
  }

  return controller.signal;
}

/**
 * 可中止的 sleep。
 *
 * @param ms - 睡眠毫秒数
 * @param signal - 可选 AbortSignal
 * @param options.throwOnAbort - true 则 abort 时 reject AbortError；false（默认）则静默 resolve
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
  options?: { throwOnAbort?: boolean }
): Promise<void> {
  const throwOnAbort = options?.throwOnAbort ?? false;

  // 快速路径：signal 已 aborted
  if (signal?.aborted) {
    if (throwOnAbort) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;

    const timer = setTimeout(() => {
      // 正常计时完成：移除 signal listener 防止泄漏
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        if (throwOnAbort) {
          reject(new DOMException('Aborted', 'AbortError'));
        } else {
          resolve();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
