import { useTerminalDimension } from './useTerminalDimensions.js';

/**
 * 获取终端高度的 hook
 * 自动监听终端 resize 事件并更新高度
 *
 * @param debounceMs - 防抖延迟时间(毫秒),默认 200ms
 * @returns 当前终端高度（行数）
 */
export function useTerminalHeight(debounceMs: number = 200): number {
  return useTerminalDimension('rows', debounceMs);
}
