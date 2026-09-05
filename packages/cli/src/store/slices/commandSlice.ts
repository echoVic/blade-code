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
  FollowUpPresentation,
} from '../types.js';

/**
 * 初始命令状态
 */
const initialCommandState: CommandState = {
  isProcessing: false,
  abortController: null,
  followUpPresentations: {},
  recoveredSteeringCount: 0,
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
        ...(!isProcessing
          ? {
              session: {
                ...state.session,
                providerAdmission: null,
                providerCircuit: null,
                providerRetry: null,
                providerStall: null,
                providerRecovery: null,
                actionStationarity: null,
              },
            }
          : {}),
      }));
    },

    /**
     * 创建 AbortController
     * 如果已存在未被中止的 controller，返回现有的
     * 如果已被中止或不存在，创建新的
     */
    createAbortController: () => {
      const existing = get().command.abortController;
      // 如果已有未被中止的 controller，先中止它（用户提交新消息时中断旧任务）
      if (existing && !existing.signal.aborted) {
        existing.abort('interrupted-by-new-command');
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
     * - 发送 abort signal（携带 reason）
     * - 重置 isProcessing（乐观更新，立即响应用户）
     * - 清空待处理队列
     *
     * @param reason - abort 原因：'user-cancel'（Esc）或 'interrupt'（新消息中断），默认 'user-cancel'
     *
     * 注意：不清空 abortController，让后续代码能通过 signal.aborted 检测到中止状态
     * abortController 会在 clearAbortController() 中清理
     */
    abort: (reason?: string) => {
      const { abortController } = get().command;

      // 发送 abort signal，携带 reason
      if (abortController && !abortController.signal.aborted) {
        abortController.abort(reason ?? 'user-cancel');
      }

      // 重置 command 状态（保留 abortController 和已提交的 durable queue 展示缓存）
      set((state) => ({
        command: {
          ...state.command,
          isProcessing: false,
          // 不清空 abortController，让后续代码能检测 signal.aborted
        },
        session: {
          ...state.session,
          providerAdmission: null,
          providerCircuit: null,
          providerRetry: null,
          providerStall: null,
          providerRecovery: null,
          actionStationarity: null,
        },
      }));
    },

    rememberFollowUpPresentation: (
      messageId: string,
      command: FollowUpPresentation
    ) => {
      set((state) => ({
        command: {
          ...state.command,
          followUpPresentations: Object.fromEntries(
            [
              ...Object.entries(state.command.followUpPresentations),
              [messageId, command],
            ].slice(-20)
          ),
        },
      }));
    },

    takeFollowUpPresentation: (messageId: string): FollowUpPresentation | undefined => {
      const command = get().command.followUpPresentations[messageId];
      if (!command) return undefined;
      set((state) => ({
        command: {
          ...state.command,
          followUpPresentations: Object.fromEntries(
            Object.entries(state.command.followUpPresentations).filter(
              ([candidate]) => candidate !== messageId
            )
          ),
        },
      }));
      return command;
    },

    clearFollowUpPresentations: () => {
      set((state) => ({
        command: {
          ...state.command,
          followUpPresentations: {},
        },
      }));
    },

    setRecoveredSteeringCount: (count: number) => {
      set((state) => ({
        command: {
          ...state.command,
          recoveredSteeringCount: Math.max(0, count),
        },
      }));
    },
  },
});
