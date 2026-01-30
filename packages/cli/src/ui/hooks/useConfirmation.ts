import { useMemoizedFn } from 'ahooks';
import { useMemo, useRef, useState } from 'react';
import type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';

/**
 * 确认状态
 */
interface ConfirmationState {
  isVisible: boolean;
  details: ConfirmationDetails | null;
  resolver: ((response: ConfirmationResponse) => void) | null;
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
  const activeRef = useRef<{
    details: ConfirmationDetails;
    resolve: (response: ConfirmationResponse) => void;
  } | null>(null);
  const queueRef = useRef<
    {
      details: ConfirmationDetails;
      resolve: (response: ConfirmationResponse) => void;
    }[]
  >([]);

  const showActive = useMemoizedFn(
    (
      entry: {
        details: ConfirmationDetails;
        resolve: (response: ConfirmationResponse) => void;
      } | null
    ) => {
      activeRef.current = entry;
      setConfirmationState({
        isVisible: Boolean(entry),
        details: entry?.details ?? null,
        resolver: entry?.resolve ?? null,
      });
    }
  );

  /**
   * 显示确认对话框
   */
  const showConfirmation = useMemoizedFn(
    (details: ConfirmationDetails): Promise<ConfirmationResponse> => {
      return new Promise((resolve) => {
        const entry = { details, resolve };
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
    if (activeRef.current) {
      activeRef.current.resolve(response);
    }

    const next = queueRef.current.shift() ?? null;
    showActive(next);
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
  };
};
