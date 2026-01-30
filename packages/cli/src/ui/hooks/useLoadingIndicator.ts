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
 * @param paused - 是否暂停计时器（当被弹窗遮挡时使用）
 * @returns 加载指示器状态（短语和计时器）
 */
export function useLoadingIndicator(
  isProcessing: boolean,
  isWaiting = false,
  paused = false
): LoadingIndicatorState {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  // 使用短语循环器（传递 paused 参数）
  const currentPhrase = usePhraseCycler(isProcessing, isWaiting, paused);

  // 计时器逻辑
  // 当 paused=true 时暂停计时器更新，但保持 startTime 不变（恢复后继续计时）
  useEffect(() => {
    if (!isProcessing) {
      // 停止处理时重置计时器
      setElapsedTime(0);
      setStartTime(null);
      return;
    }

    // 暂停时不启动定时器，但保持当前状态
    if (paused) {
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
  }, [isProcessing, startTime, paused]);

  return {
    currentPhrase,
    elapsedTime,
  };
}
