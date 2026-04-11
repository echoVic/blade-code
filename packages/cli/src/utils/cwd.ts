/**
 * 统一的 CWD 访问层
 *
 * 参考 Claude Code 的 utils/cwd.ts 设计：
 * - AsyncLocalStorage 支持子代理 cwd 覆写
 * - getCwd() 是所有模块获取工作目录的唯一入口
 * - 替代直接调用 process.cwd()
 */

import { AsyncLocalStorage } from 'async_hooks';
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js';

const cwdOverrideStorage = new AsyncLocalStorage<string>();

/**
 * 在指定 cwd 覆写下运行函数（用于子代理隔离）。
 * 所有在 fn 内（包括异步后续）对 pwd()/getCwd() 的调用都会返回覆写后的 cwd，
 * 不影响其他并发上下文。
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn);
}

/**
 * 获取当前工作目录（优先 AsyncLocalStorage 覆写，否则全局 STATE）
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState();
}

/**
 * 安全获取当前工作目录，异常时回退到 originalCwd
 */
export function getCwd(): string {
  try {
    return pwd();
  } catch {
    return getOriginalCwd();
  }
}
