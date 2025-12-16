/**
 * Command Slice - 命令执行状态管理
 *
 * 职责：
 * - 命令处理状态 (isProcessing)
 * - AbortController 管理
 * - 中止操作
 *
 * 注意：这些状态都是临时的，不应该持久化
 */

import type { StateCreator } from 'zustand';
import type { BladeStore, CommandSlice, CommandState } from '../types.js';

/**
 * 初始命令状态
 */
const initialCommandState: CommandState = {
  isProcessing: false,
  abortController: null,
};

/**
 * 创建 Command Slice
 */
export const createCommandSlice: StateCreator<
  BladeStore,
  [],
  [],
  CommandSlice
> = (set, get) => ({
  ...initialCommandState,

  actions: {
    /**
     * 设置处理状态
     */
    setProcessing: (isProcessing: boolean) => {
      set((state) => ({
        command: { ...state.command, isProcessing },
      }));
    },

    /**
     * 创建 AbortController
     */
    createAbortController: () => {
      const controller = new AbortController();
      set((state) => ({
        command: { ...state.command, abortController: controller },
      }));
      return controller;
    },

    /**
     * 清理 AbortController
     */
    clearAbortController: () => {
      set((state) => ({
        command: { ...state.command, abortController: null },
      }));
    },

    /**
     * 中止当前任务
     * - 发送 abort signal
     * - 重置 isProcessing
     * - 重置 isThinking (跨 slice)
     */
    abort: () => {
      const { abortController } = get().command;

      // 发送 abort signal
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      // 重置 session 的 isThinking 状态
      get().session.actions.setThinking(false);

      // 重置 command 状态
      set((state) => ({
        command: {
          ...state.command,
          isProcessing: false,
          abortController: null,
        },
      }));
    },
  },
});
