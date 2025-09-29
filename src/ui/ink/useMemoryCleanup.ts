/**
 * React Hook - 内存清理钩子
 */
import { useEffect, useRef } from 'react';
import { memoryManager } from './MemoryManager.js';

/**
 * 内存清理 Hook
 * @param componentId 组件 ID
 * @param memorySize 组件内存大小（字节）
 * @param cleanupCallback 清理回调函数
 */
export const useMemoryCleanup = (
  componentId: string,
  memorySize: number,
  cleanupCallback?: () => void
): void => {
  const cleanupRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    // 注册内存使用
    memoryManager.trackMemoryUsage(componentId, memorySize);

    // 注册清理回调
    const cleanup = () => {
      // 执行组件特定的清理逻辑
      if (cleanupCallback) {
        cleanupCallback();
      }

      // 从内存管理器中移除组件
      // 这里可以添加更多清理逻辑
    };

    cleanupRef.current = cleanup;
    memoryManager.registerCleanupCallback(cleanup);

    // 组件卸载时清理
    return () => {
      if (cleanupRef.current) {
        memoryManager.unregisterCleanupCallback(cleanupRef.current);
        cleanupRef.current();
      }
      // 从内存使用记录中移除
      // 注意：这里应该在实际的清理回调中处理
    };
  }, [componentId, memorySize, cleanupCallback]);
};
