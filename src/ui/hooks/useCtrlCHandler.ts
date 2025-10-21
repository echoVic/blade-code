import { useApp } from 'ink';
import { useCallback, useEffect, useRef } from 'react';

/**
 * 智能 Ctrl+C 处理 Hook
 *
 * 实现双击退出逻辑：
 * - 如果当前有任务在执行：第一次按下 Ctrl+C 停止任务，第二次按下退出应用
 * - 如果当前没有任务执行：第一次按下 Ctrl+C 直接退出应用
 *
 * @param isProcessing 是否正在执行任务
 * @param onAbort 停止任务的回调函数（可选）
 * @returns Ctrl+C 处理函数
 *
 * @example
 * // 在组件中使用
 * const handleCtrlC = useCtrlCHandler(isProcessing, handleAbort);
 *
 * useInput((input, key) => {
 *   if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
 *     handleCtrlC();
 *     return;
 *   }
 * }, { isActive: isFocused });
 */
export const useCtrlCHandler = (
  isProcessing: boolean,
  onAbort?: () => void
): (() => void) => {
  const { exit } = useApp();
  const hasAbortedRef = useRef(false);

  /**
   * 处理 Ctrl+C 按键事件
   */
  const handleCtrlC = useCallback(() => {
    if (isProcessing) {
      // 有任务在执行
      if (!hasAbortedRef.current) {
        // 第一次按下：停止任务
        hasAbortedRef.current = true;
        if (onAbort) {
          onAbort();
        }
        console.log('任务已停止。再按一次 Ctrl+C 退出应用。');
      } else {
        // 第二次按下：退出应用
        exit();
      }
    } else {
      // 没有任务在执行：直接退出应用
      exit();
    }
  }, [isProcessing, onAbort, exit]);

  /**
   * 当任务停止时，重置中止标志
   * 这样下一次有任务时，又需要双击才能退出
   */
  useEffect(() => {
    if (!isProcessing) {
      hasAbortedRef.current = false;
    }
  }, [isProcessing]);

  return handleCtrlC;
};
