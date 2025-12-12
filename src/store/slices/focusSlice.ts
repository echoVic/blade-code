/**
 * Focus Slice - 焦点状态管理
 *
 * 职责：
 * - 当前焦点管理
 * - 焦点历史（用于恢复）
 */

import type { StateCreator } from 'zustand';
import type { BladeStore, FocusId, FocusSlice, FocusState } from '../types.js';

/**
 * 初始焦点状态
 */
const initialFocusState: FocusState = {
  currentFocus: 'main-input' as FocusId,
  previousFocus: null,
};

/**
 * 创建 Focus Slice
 */
export const createFocusSlice: StateCreator<BladeStore, [], [], FocusSlice> = (
  set
) => ({
  ...initialFocusState,

  actions: {
    /**
     * 设置焦点
     */
    setFocus: (id: FocusId) => {
      set((state) => ({
        focus: {
          ...state.focus,
          currentFocus: id,
          previousFocus: state.focus.currentFocus,
        },
      }));
    },

    /**
     * 恢复上一个焦点
     */
    restorePreviousFocus: () => {
      set((state) => ({
        focus: {
          ...state.focus,
          currentFocus: state.focus.previousFocus || ('main-input' as FocusId),
          previousFocus: null,
        },
      }));
    },
  },
});
