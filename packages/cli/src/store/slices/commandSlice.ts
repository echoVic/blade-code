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
import type {
  BladeStore,
  CommandSlice,
  CommandState,
  PendingCommand,
} from '../types.js';

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
export const createCommandSlice: StateCreator<BladeStore, [], [], CommandSlice> = (
  set,
  get
) => ({
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
     * 如果已存在未被中止的 controller，返回现有的
     * 如果已被中止或不存在，创建新的
     */
    createAbortController: () => {
      const existing = get().command.abortController;
      // 如果已有未被中止的 controller，直接返回
      if (existing && !existing.signal.aborted) {
        return existing;
      }
      // 创建新的 controller
      const controller = new AbortController();
      set((state) => ({
        command: { ...state.command, abortController: controller },
      }));
      return controller;
    },

    /**
     * 获取当前的 AbortController
     * 用于在 finally 块中检查是否应该重置状态
     */
    getAbortController: () => {
      return get().command.abortController;
    },

    /**
     * 清理 AbortController
     * @param expectedController 可选，只有当 store 中的 controller 与此相同时才清除
     * 用于防止新任务的 controller 被旧任务的 finally 块误清
     */
    clearAbortController: (expectedController?: AbortController) => {
      const current = get().command.abortController;
      // 如果指定了期望的 controller，只有匹配时才清除
      // 这防止了竞态条件：旧任务的 finally 不会清除新任务的 controller
      if (expectedController !== undefined && current !== expectedController) {
        return; // 不匹配，跳过清除
      }
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
     * 注意：不清空 abortController，让后续代码能通过 signal.aborted 检测到中止状态
     * abortController 会在 clearAbortController() 中清理
     */
    abort: () => {
      const { abortController } = get().command;

      // 发送 abort signal
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      // 重置 command 状态并清空队列（保留 abortController 供后续检测）
      set((state) => ({
        command: {
          ...state.command,
          isProcessing: false,
          // 不清空 abortController，让后续代码能检测 signal.aborted
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
