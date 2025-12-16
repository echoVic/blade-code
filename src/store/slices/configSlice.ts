/**
 * Config Slice - 配置状态管理
 *
 * 职责：
 * - 运行时配置存储（RuntimeConfig）
 * - 配置的内存更新（Store as SSOT）
 * - 与 ConfigService 配合实现持久化
 *
 * 注意：
 * - 这个 slice 只负责内存状态管理
 * - 持久化逻辑在 vanilla.ts 的 configActions() 中
 */

import type { StateCreator } from 'zustand';
import type { RuntimeConfig } from '../../config/types.js';
import type { BladeStore, ConfigSlice, ConfigState } from '../types.js';

/**
 * 初始配置状态
 */
const initialConfigState: ConfigState = {
  config: null,
};

/**
 * 创建 Config Slice
 */
export const createConfigSlice: StateCreator<BladeStore, [], [], ConfigSlice> = (
  set
) => ({
  ...initialConfigState,

  actions: {
    /**
     * 设置完整配置
     */
    setConfig: (config: RuntimeConfig) => {
      set((state) => ({
        config: { ...state.config, config },
      }));
    },

    /**
     * 更新部分配置
     * @throws {Error} 如果 config 未初始化
     */
    updateConfig: (partial: Partial<RuntimeConfig>) => {
      set((state) => {
        if (!state.config.config) {
          // 配置未初始化时，抛出错误
          throw new Error(
            `[ConfigSlice] Config not initialized. Cannot update: ${JSON.stringify(partial)}`
          );
        }

        return {
          config: {
            ...state.config,
            config: { ...state.config.config, ...partial },
          },
        };
      });
    },
  },
});
