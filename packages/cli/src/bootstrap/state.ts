/**
 * 全局 CWD 状态单例
 *
 * 参考 Claude Code 的 bootstrap/state.ts 设计：
 * - cwd: 当前工作目录，可被 worktree 等场景改变
 * - originalCwd: 进程启动时的原始目录
 * - projectRoot: 稳定的项目根目录，用于项目标识（history, skills, sessions），启动后不变
 */

import { realpathSync } from 'fs';
import { cwd } from 'process';

interface CwdState {
  /** 当前工作目录，可被 worktree 等场景改变 */
  cwd: string;
  /** 进程启动时的原始目录 */
  originalCwd: string;
  /** 稳定的项目根目录，用于项目标识（history, skills, sessions），启动后不变 */
  projectRoot: string;
}

let STATE: CwdState | null = null;

function initState(): CwdState {
  let resolvedCwd = '';
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd();
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC');
    } catch {
      resolvedCwd = rawCwd.normalize('NFC');
    }
  }
  return {
    cwd: resolvedCwd,
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
  };
}

function getState(): CwdState {
  if (!STATE) {
    STATE = initState();
  }
  return STATE;
}

export function getCwdState(): string {
  return getState().cwd;
}

export function setCwdState(newCwd: string): void {
  getState().cwd = newCwd.normalize('NFC');
}

export function getOriginalCwd(): string {
  return getState().originalCwd;
}

export function setOriginalCwd(newCwd: string): void {
  getState().originalCwd = newCwd.normalize('NFC');
}

export function getProjectRoot(): string {
  return getState().projectRoot;
}

export function setProjectRoot(root: string): void {
  getState().projectRoot = root.normalize('NFC');
}
