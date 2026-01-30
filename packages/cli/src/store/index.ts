/**
 * Blade Store - React 入口
 *
 * 遵循准则：
 * 1. 只暴露 actions - 不直接暴露 set
 * 2. 强选择器约束 - 使用选择器访问状态
 * 3. 单一数据源 - React 订阅 vanilla store
 * 4. vanilla store 对外 - 供 Agent 使用
 */

import { useStore } from 'zustand';
import type { BladeStore } from './types.js';
import { vanillaStore } from './vanilla.js';

/**
 * React Hook - 订阅 Blade Store
 *
 * 使用 useStore 订阅 vanilla store，确保 React 组件和
 * 非 React 环境（Agent、服务层）共享同一个 store 实例。
 *
 * @example
 * // 基本用法
 * const messages = useBladeStore((state) => state.session.messages);
 *
 * // 选择多个状态
 * const { sessionId, isProcessing } = useBladeStore((state) => ({
 *   sessionId: state.session.sessionId,
 *   isProcessing: state.command.isProcessing,
 * }));
 */
export function useBladeStore<T>(selector: (state: BladeStore) => T): T {
  return useStore(vanillaStore, selector);
}

// 导出选择器
export * from './selectors/index.js';
