/**
 * usePhraseCycler Hook 管理加载时显示的短语循环 <p> 功能： - 简洁的加载动词短语 - 每 15 秒自动切换 - 1/4 概率显示实用提示，3/4
 * 概率显示加载短语
 */

import { useEffect, useRef, useState } from 'react';
import phrases from './phrases.json';

// 切换间隔：15 秒
const PHRASE_CHANGE_INTERVAL_MS = 15000;
const WAITING_PHRASE = '等待用户确认...';

function selectRandomPhrase(): string {
  const showTip = Math.random() < 1 / 4;
  if (showTip) {
    const randomIndex = Math.floor(Math.random() * phrases.tips.length);
    return phrases.tips[randomIndex];
  }

  const randomIndex = Math.floor(Math.random() * phrases.loading.length);
  return phrases.loading[randomIndex];
}

/**
 * usePhraseCycler Hook
 *
 * @param isActive - 是否激活短语循环（通常在 Agent 处理中时为 true）
 * @param isWaiting - 是否等待用户确认（显示固定等待文本）
 * @param paused - 是否暂停短语切换（当被弹窗遮挡时使用）
 * @returns 当前显示的短语
 */
export function usePhraseCycler(
  isActive: boolean,
  isWaiting: boolean,
  paused = false
): string {
  const [currentPhrase, setCurrentPhrase] = useState<string>('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // 等待确认时显示固定文本
    if (isWaiting) {
      setCurrentPhrase(WAITING_PHRASE);
      return;
    }

    // 未激活时不显示短语
    if (!isActive) {
      setCurrentPhrase('');
      return;
    }

    setCurrentPhrase((current) =>
      current === '' || current === WAITING_PHRASE ? selectRandomPhrase() : current
    );

    // 每 15 秒切换一次
    const intervalId = setInterval(() => {
      if (!pausedRef.current) {
        setCurrentPhrase(selectRandomPhrase());
      }
    }, PHRASE_CHANGE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [isActive, isWaiting]);

  return currentPhrase;
}
