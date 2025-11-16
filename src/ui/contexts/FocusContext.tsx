import { useMemoizedFn } from 'ahooks';
import React, { createContext, useContext, useMemo, useState } from 'react';

/**
 * 焦点 ID 枚举
 * 定义所有可聚焦的组件
 */
export enum FocusId {
  MAIN_INPUT = 'main-input',
  SESSION_SELECTOR = 'session-selector',
  CONFIRMATION_PROMPT = 'confirmation-prompt',
  THEME_SELECTOR = 'theme-selector',
  MODEL_SELECTOR = 'model-selector',
  MODEL_CONFIG_WIZARD = 'model-config-wizard', // 统一的模型配置向导（支持 setup 和 add 模式）
  PERMISSIONS_MANAGER = 'permissions-manager',
  AGENTS_MANAGER = 'agents-manager',
  AGENT_CREATION_WIZARD = 'agent-creation-wizard',
}

/**
 * 焦点状态
 */
export interface FocusState {
  currentFocus: FocusId;
  previousFocus: FocusId | null;
}

/**
 * 焦点上下文类型
 */
export interface FocusContextType {
  state: FocusState;
  setFocus: (id: FocusId) => void;
  restorePreviousFocus: () => void;
}

/**
 * 焦点上下文
 */
const FocusContext = createContext<FocusContextType | undefined>(undefined);

/**
 * 焦点提供者组件
 * 负责管理全局焦点状态
 */
export const FocusProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [state, setState] = useState<FocusState>({
    currentFocus: FocusId.MAIN_INPUT,
    previousFocus: null,
  });

  /**
   * 设置焦点
   * @param id 目标组件的焦点 ID
   */
  const setFocus = useMemoizedFn((id: FocusId) => {
    setState((prev) => ({
      currentFocus: id,
      previousFocus: prev.currentFocus,
    }));
  });

  /**
   * 恢复到上一个焦点
   * 如果没有上一个焦点，则回到主输入框
   */
  const restorePreviousFocus = useMemoizedFn(() => {
    setState((prev) => ({
      currentFocus: prev.previousFocus || FocusId.MAIN_INPUT,
      previousFocus: null,
    }));
  });

  const value = useMemo<FocusContextType>(
    () => ({ state, setFocus, restorePreviousFocus }),
    [state, setFocus, restorePreviousFocus]
  );

  return (
    <FocusContext.Provider value={value}>
      {children}
    </FocusContext.Provider>
  );
};

/**
 * 使用焦点上下文的 Hook
 * @returns 焦点上下文
 * @throws 如果在 FocusProvider 外部使用会抛出错误
 */
export const useFocusContext = (): FocusContextType => {
  const context = useContext(FocusContext);
  if (!context) {
    throw new Error('useFocusContext must be used within a FocusProvider');
  }
  return context;
};
