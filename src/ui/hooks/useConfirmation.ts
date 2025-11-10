import { useMemoizedFn } from 'ahooks';
import { useMemo, useState } from 'react';
import type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';

/**
 * 确认状态
 */
export interface ConfirmationState {
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

  /**
   * 显示确认对话框
   */
  const showConfirmation = useMemoizedFn(
    (details: ConfirmationDetails): Promise<ConfirmationResponse> => {
      return new Promise((resolve) => {
        setConfirmationState({
          isVisible: true,
          details,
          resolver: resolve,
        });
      });
    }
  );

  /**
   * 处理用户响应
   */
  const handleResponse = useMemoizedFn(
    (response: ConfirmationResponse) => {
      if (confirmationState.resolver) {
        confirmationState.resolver(response);
      }

      // 重置状态
      setConfirmationState({
        isVisible: false,
        details: null,
        resolver: null,
      });
    }
  );

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
