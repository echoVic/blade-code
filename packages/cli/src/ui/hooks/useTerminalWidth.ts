import { useTerminalDimension } from './useTerminalDimensions.js';

/**
 * 获取终端宽度的 hook
 * 自动监听终端 resize 事件并更新宽度
 *
 * @param debounceMs - 防抖延迟时间(毫秒),默认 200ms
 * @returns 当前终端宽度
 */
export function useTerminalWidth(debounceMs: number = 200): number {
  return useTerminalDimension('columns', debounceMs);
}
