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
import type { BladeStore, CommandSlice, CommandState, PendingCommand } from '../types.js';

/**
 * 初始命令状态
 */
const initialCommandState: CommandState = {
  isProcessing: false,
  abortController: null,
  pendingCommands: [],
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
     * - 重置 isProcessing（乐观更新，立即响应用户）
     * - 清空待处理队列
     *
     * 采用乐观更新策略：立即重置状态让 UI 响应，
     * 后续 LLM 返回的结果会被 abortMessageSentRef 机制过滤掉。
     */
    abort: () => {
      const { abortController } = get().command;

      // 发送 abort signal
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      // 重置 command 状态并清空队列
      set((state) => ({
        command: {
          ...state.command,
          isProcessing: false,
          abortController: null,
          pendingCommands: [],
        },
      }));
    },

    /**
     * 将命令加入待处理队列（支持图片）
     */
    enqueueCommand: (command: PendingCommand) => {
      set((state) => ({
        command: {
          ...state.command,
          pendingCommands: [...state.command.pendingCommands, command],
        },
      }));
    },

    /**
     * 从队列取出下一个命令
     */
    dequeueCommand: (): PendingCommand | undefined => {
      const { pendingCommands } = get().command;
      if (pendingCommands.length === 0) {
        return undefined;
      }

      const [nextCommand, ...rest] = pendingCommands;
      set((state) => ({
        command: {
          ...state.command,
          pendingCommands: rest,
        },
      }));

      return nextCommand;
    },

    /**
     * 清空待处理队列
     */
    clearQueue: () => {
      set((state) => ({
        command: {
          ...state.command,
          pendingCommands: [],
        },
      }));
    },
  },
});
