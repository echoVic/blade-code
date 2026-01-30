import { useStdout } from 'ink';
import { debounce } from 'lodash-es';
import { useEffect, useState } from 'react';

/**
 * 获取终端宽度的 hook
 * 自动监听终端 resize 事件并更新宽度
 *
 * @param debounceMs - 防抖延迟时间(毫秒),默认 200ms
 * @returns 当前终端宽度
 */
export function useTerminalWidth(debounceMs: number = 200): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 80);

  useEffect(() => {
    // 创建防抖的更新函数
    const updateWidth = debounce(() => {
      setWidth(stdout.columns || 80);
    }, debounceMs);

    // 立即执行一次,确保初始值正确
    updateWidth();

    // 监听 resize 事件
    stdout.on('resize', updateWidth);

    return () => {
      stdout.off('resize', updateWidth);
      updateWidth.cancel(); // 清理防抖定时器
    };
  }, [stdout, debounceMs]);

  return width;
}
