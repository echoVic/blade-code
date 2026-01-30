import { useStdout } from 'ink';
import { debounce } from 'lodash-es';
import { useEffect, useState } from 'react';

/**
 * 获取终端高度的 hook
 * 自动监听终端 resize 事件并更新高度
 *
 * @param debounceMs - 防抖延迟时间(毫秒),默认 200ms
 * @returns 当前终端高度（行数）
 */
export function useTerminalHeight(debounceMs: number = 200): number {
  const { stdout } = useStdout();
  const [height, setHeight] = useState(stdout.rows || 24);

  useEffect(() => {
    // 创建防抖的更新函数
    const updateHeight = debounce(() => {
      setHeight(stdout.rows || 24);
    }, debounceMs);

    // 立即执行一次,确保初始值正确
    updateHeight();

    // 监听 resize 事件
    stdout.on('resize', updateHeight);

    return () => {
      stdout.off('resize', updateHeight);
      updateHeight.cancel(); // 清理防抖定时器
    };
  }, [stdout, debounceMs]);

  return height;
}
