import { useMemoizedFn } from 'ahooks';
import { useMemo, useRef, useState } from 'react';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationDetails,
  type ConfirmationHandler,
  type ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';

/**
 * 确认状态
 */
interface ConfirmationState {
  isVisible: boolean;
  details: ConfirmationDetails | null;
  resolver: ((response: ConfirmationResponse) => void) | null;
}

interface PendingConfirmation {
  details: ConfirmationDetails;
  resolve: (response: ConfirmationResponse) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

/**
 * 确认管理 Hook
 * 提供一个 ConfirmationHandler 实现和确认状态管理
 */
export const useConfirmation = () => {
  const [confirmationState, setConfirmationState] = useState<ConfirmationState>({
    isVisible: false,
    details: null,
    resolver: null,
  });
  const activeRef = useRef<PendingConfirmation | null>(null);
  const queueRef = useRef<PendingConfirmation[]>([]);

  const showActive = useMemoizedFn((entry: PendingConfirmation | null) => {
    activeRef.current = entry;
    setConfirmationState({
      isVisible: Boolean(entry),
      details: entry?.details ?? null,
      resolver: entry?.resolve ?? null,
    });
  });

  const settle = useMemoizedFn(
    (entry: PendingConfirmation, response: ConfirmationResponse) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      entry.resolve(response);
    }
  );

  /**
   * 显示确认对话框
   */
  const showConfirmation = useMemoizedFn(
    (
      details: ConfirmationDetails,
      signal?: AbortSignal
    ): Promise<ConfirmationResponse> => {
      return new Promise((resolve) => {
        const entry: PendingConfirmation = {
          details,
          resolve,
          signal,
          settled: false,
        };
        const onAbort = () => {
          if (activeRef.current === entry) {
            settle(entry, {
              approved: false,
              reason: CONFIRMATION_ABORTED_REASON,
            });
            showActive(queueRef.current.shift() ?? null);
            return;
          }
          const index = queueRef.current.indexOf(entry);
          if (index >= 0) queueRef.current.splice(index, 1);
          settle(entry, {
            approved: false,
            reason: CONFIRMATION_ABORTED_REASON,
          });
        };
        entry.abortListener = onAbort;
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (!activeRef.current) {
          showActive(entry);
          return;
        }

        queueRef.current.push(entry);
      });
    }
  );

  /**
   * 处理用户响应
   */
  const handleResponse = useMemoizedFn((response: ConfirmationResponse) => {
    const active = activeRef.current;
    if (active) settle(active, response);

    const next = queueRef.current.shift() ?? null;
    showActive(next);
  });

  /**
   * 中止所有 pending 确认
   * Esc 取消任务时调用：用特殊 reason 标记与正常用户拒绝区分，
   * 让 ToolExecutor 能通过 signal.aborted 走取消通道而非 PERMISSION_DENIED。
   */
  const dismissAll = useMemoizedFn(() => {
    // resolve 当前活跃的确认
    if (activeRef.current) {
      settle(activeRef.current, {
        approved: false,
        reason: CONFIRMATION_ABORTED_REASON,
      });
    }
    // resolve 队列中所有 pending 确认
    for (const entry of queueRef.current) {
      settle(entry, {
        approved: false,
        reason: CONFIRMATION_ABORTED_REASON,
      });
    }
    queueRef.current = [];
    showActive(null);
  });

  /**
   * 创建 ConfirmationHandler 实例
   * 使用 useMemo 确保引用稳定性，避免 React 闭包捕获过时引用
   */
  const confirmationHandler: ConfirmationHandler = useMemo(
    () => ({
      requestConfirmation: showConfirmation,
    }),
    [showConfirmation]
  );

  return {
    confirmationState,
    confirmationHandler,
    handleResponse,
    dismissAll,
  };
};
