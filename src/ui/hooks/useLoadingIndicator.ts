/**
 * useLoadingIndicator Hook
 * 整合短语循环器和计时器功能
 *
 * 功能：
 * - 管理加载短语的显示
 * - 计算已等待时间
 * - 根据 isProcessing 状态控制激活/停用
 */

import { useEffect, useState } from 'react';
import { usePhraseCycler } from './usePhraseCycler.js';

/**
 * useLoadingIndicator Hook 返回值
 */
export interface LoadingIndicatorState {
  /** 当前显示的短语 */
  currentPhrase: string;
  /** 已等待时间（秒） */
  elapsedTime: number;
}

/**
 * useLoadingIndicator Hook
 *
 * @param isProcessing - Agent 是否正在处理
 * @param isWaiting - 是否等待用户确认
 * @returns 加载指示器状态（短语和计时器）
 */
export function useLoadingIndicator(
  isProcessing: boolean,
  isWaiting = false
): LoadingIndicatorState {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  // 使用短语循环器
  const currentPhrase = usePhraseCycler(isProcessing, isWaiting);

  // 计时器逻辑
  useEffect(() => {
    if (!isProcessing) {
      // 停止处理时重置计时器
      setElapsedTime(0);
      setStartTime(null);
      return;
    }

    // 开始处理时记录开始时间
    if (startTime === null) {
      setStartTime(Date.now());
    }

    // 每秒更新一次已用时间
    const intervalId = setInterval(() => {
      if (startTime !== null) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setElapsedTime(elapsed);
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [isProcessing, startTime]);

  return {
    currentPhrase,
    elapsedTime,
  };
}
