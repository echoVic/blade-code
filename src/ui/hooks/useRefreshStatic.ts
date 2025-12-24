/**
 * useRefreshStatic Hook
 *
 * 处理终端原生滚动模式下的 Static 组件刷新
 *
 * 背景：
 * - 当 alternateBuffer: false 时，使用终端原生滚动
 * - Ink 的 Static 组件内容会累积在终端缓冲区
 * - 需要在关键时刻（如终端 resize）清屏 + 重新挂载 Static
 *
 */

import ansiEscapes from 'ansi-escapes';
import { useStdout } from 'ink';
import { useCallback, useEffect, useRef } from 'react';
import { useBladeStore } from '../../store/index.js';
import { useTerminalWidth } from './useTerminalWidth.js';

/**
 * 刷新 Static 组件的 Hook
 *
 * 功能：
 * - 清除终端屏幕
 * - 增加 clearCount 以强制 Static 组件重新挂载
 *
 * 触发时机：
 * - 终端宽度变化（自动，带 300ms 防抖）
 * - 手动调用 refreshStatic()
 */
export function useRefreshStatic() {
  const { stdout } = useStdout();
  const terminalWidth = useTerminalWidth();
  const isInitialMount = useRef(true);

  // 获取 store 的 incrementClearCount action
  const incrementClearCount = useBladeStore(
    (state) => state.session.actions.incrementClearCount
  );

  /**
   * 刷新 Static 组件
   * - 清屏（使用 ANSI 转义序列）
   * - 增加 clearCount 强制 Static 重新挂载
   */
  const refreshStatic = useCallback(() => {
    // 清除终端屏幕（非 alternateBuffer 模式）
    if (stdout) {
      stdout.write(ansiEscapes.clearTerminal);
    }
    // 增加 clearCount 以强制 Static 组件重新挂载
    incrementClearCount();
  }, [stdout, incrementClearCount]);

  // 终端宽度变化时自动刷新（带 300ms 防抖）
  useEffect(() => {
    // 跳过首次挂载
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const handler = setTimeout(() => {
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [terminalWidth, refreshStatic]);

  return { refreshStatic };
}
