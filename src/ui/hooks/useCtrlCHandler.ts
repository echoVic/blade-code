import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import { getConfigService } from '../../config/index.js';
import { appActions } from '../../store/vanilla.js';

/**
 * 智能 Ctrl+C 处理 Hook
 *
 * 双击退出逻辑：第一次显示提示，第二次退出应用
 */
export const useCtrlCHandler = (
  isProcessing: boolean,
  onAbort?: () => void
): (() => void) => {
  const hasAbortedRef = useRef(false);
  const hintTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 启动 3 秒自动清除定时器
  const startHintTimer = useMemoizedFn(() => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      appActions().setAwaitingSecondCtrlC(false);
      hasAbortedRef.current = false;
      hintTimerRef.current = null;
    }, 3000);
  });

  // 强制退出（SIGKILL 绕过 Ink 事件循环）
  const forceExit = () => {
    try {
      getConfigService()
        .flush()
        .catch(() => {
          // 忽略刷新错误
        });
    } catch {
      // 忽略
    }
    process.kill(process.pid, 'SIGKILL');
  };

  const handleCtrlC = useMemoizedFn(() => {
    if (!hasAbortedRef.current) {
      // 第一次按下
      hasAbortedRef.current = true;
      if (isProcessing && onAbort) onAbort();
      appActions().setAwaitingSecondCtrlC(true);
      startHintTimer();
    } else {
      // 第二次按下：退出
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
      appActions().setAwaitingSecondCtrlC(false);
      forceExit();
    }
  });

  // 任务开始时重置状态
  useEffect(() => {
    if (isProcessing) {
      appActions().setAwaitingSecondCtrlC(false);
      hasAbortedRef.current = false;
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    }
  }, [isProcessing]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

  return handleCtrlC;
};
