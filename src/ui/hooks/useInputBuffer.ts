import { useMemoizedFn } from 'ahooks';
import { useState } from 'react';

/**
 * 输入缓冲区接口
 * 简化设计：直接使用 useState，让 React 自己管理状态
 */
export interface InputBuffer {
  /** 当前输入值 */
  value: string;
  /** 光标位置 */
  cursorPosition: number;
  /** 设置输入值 */
  setValue: (value: string) => void;
  /** 设置光标位置 */
  setCursorPosition: (position: number) => void;
  /** 清空输入 */
  clear: () => void;
}

/**
 * 输入缓冲区 Hook
 *
 * 修复方案：使用 useState 替代 ref + forceUpdate
 * - useState 本身就会在组件重渲染时保持状态
 * - 不需要 useMemo，因为我们直接返回原始值和 setter
 * - 避免了复杂的 ref + useMemo 依赖项问题
 */
export function useInputBuffer(
  initialValue: string = '',
  initialCursorPosition: number = 0
): InputBuffer {
  // 使用单一状态对象，避免多次setState导致重复渲染
  const [state, setState] = useState({
    value: initialValue,
    cursorPosition: initialCursorPosition
  });

  // 设置值（尽量保持光标位置，但不会自动调整）
  // 注意：光标位置应该由调用方通过 setCursorPosition 明确设置
  const setValue = useMemoizedFn((newValue: string) => {
    setState(prev => ({
      value: newValue,
      // 不自动调整光标位置，保持原值
      // 如果需要调整，调用方应该显式调用 setCursorPosition
      cursorPosition: prev.cursorPosition
    }));
  });

  // 光标位置设置（带边界检查）
  const setCursorPosition = useMemoizedFn((position: number) => {
    setState(prev => ({
      ...prev,
      cursorPosition: Math.max(0, Math.min(position, prev.value.length))
    }));
  });

  // 清空
  const clear = useMemoizedFn(() => {
    setState({ value: '', cursorPosition: 0 });
  });

  // 直接返回对象
  // 使用单一state对象后，每次状态变化只触发一次渲染
  return {
    value: state.value,
    cursorPosition: state.cursorPosition,
    setValue,
    setCursorPosition,
    clear,
  };
}
