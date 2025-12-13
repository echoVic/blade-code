import { useMemoizedFn } from 'ahooks';
import { useApp } from 'ink';
import { useEffect, useRef } from 'react';
import { getConfigService } from '../../config/index.js';
import { appActions } from '../../store/vanilla.js';

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
  const hintTimerRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * 启动提示定时器（3 秒后自动清除提示）
   */
  const startHintTimer = useMemoizedFn(() => {
    // 清除旧定时器
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
    }

    // 设置新定时器：3 秒后清除提示和中止标志
    hintTimerRef.current = setTimeout(() => {
      appActions().setAwaitingSecondCtrlC(false);
      hasAbortedRef.current = false;
      hintTimerRef.current = null;
    }, 3000);
  });

  /**
   * 处理 Ctrl+C 按键事件
   */
  const handleCtrlC = useMemoizedFn(async () => {
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
        // 第二次按下：清除定时器并退出应用（带配置刷新）
        if (hintTimerRef.current) {
          clearTimeout(hintTimerRef.current);
          hintTimerRef.current = null;
        }
        appActions().setAwaitingSecondCtrlC(false);
        await flushConfigAndExit();
      }
    } else {
      // 没有任务在执行：第一次按下显示提示，第二次退出
      if (!hasAbortedRef.current) {
        hasAbortedRef.current = true;
        appActions().setAwaitingSecondCtrlC(true);
        console.log('再按一次 Ctrl+C 退出应用。');
        // 启动 3 秒自动清除定时器
        startHintTimer();
      } else {
        // 第二次按下：清除定时器并退出应用（带配置刷新）
        if (hintTimerRef.current) {
          clearTimeout(hintTimerRef.current);
          hintTimerRef.current = null;
        }
        appActions().setAwaitingSecondCtrlC(false);
        await flushConfigAndExit();
      }
    }
  });

  /**
   * 刷新配置并退出（带超时保护）
   */
  const flushConfigAndExit = useMemoizedFn(async () => {
    // 设置 500ms 超时：如果刷新卡住，强制退出
    const forceExitTimer = setTimeout(() => {
      exit();
    }, 500);

    try {
      // 立即刷新所有待持久化的配置（跳过 300ms 防抖）
      await Promise.race([
        getConfigService().flush(),
        new Promise((resolve) => setTimeout(resolve, 300)), // 最多等 300ms
      ]);
    } catch (_error) {
      // 刷新失败也要退出（不卡住）
    } finally {
      clearTimeout(forceExitTimer);
      exit();
    }
  });

  /**
   * 当任务状态变化时，重置相关状态
   * - 任务停止时：重置中止标志（下次任务重新需要双击）
   * - 任务开始时：清除 Ctrl+C 提示状态和定时器（用户开始新任务）
   */
  useEffect(() => {
    if (!isProcessing) {
      hasAbortedRef.current = false;
    } else {
      // 开始新任务时，清除 Ctrl+C 提示和定时器
      appActions().setAwaitingSecondCtrlC(false);
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    }
  }, [isProcessing]);

  /**
   * 组件卸载时清理定时器
   */
  useEffect(() => {
    return () => {
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
      }
    };
  }, []);

  return handleCtrlC;
};
