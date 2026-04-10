/**
 * Raw Streaming Renderer
 *
 * 绕过 React/Ink 的渲染周期，直接通过 process.stdout.write 输出流式 tail 内容。
 *
 * 设计原理：
 * - 流式消息的 tail 部分（当前正在接收的未完成行）是最高频更新的部分
 * - 通过 Ink 渲染这部分内容会触发 React reconciliation + Ink ANSI diff，开销大
 * - 此模块直接管理一个 "raw 区域"，用 ANSI cursor save/restore 原地更新
 * - 已完成的 markdown blocks 仍由 MessageArea 的 Static 组件渲染（保持高质量格式化）
 *
 * 工作流程：
 * 1. MessageArea 检测到流式消息时调用 activate()
 * 2. 每次 streaming version 变化时，MessageArea 调用 renderTail() 而非渲染 React 组件
 * 3. renderTail() 使用 ANSI escape 直接覆写 raw 区域
 * 4. 流式结束时调用 clear() 清除 raw 区域
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { themeManager } from '../themes/ThemeManager.js';

/** Renderer 状态 */
interface RawRendererState {
  active: boolean;
  /** raw 区域当前占用的行数 */
  renderedLineCount: number;
  /** 上一帧的内容（用于差量对比） */
  lastRenderedLines: string[];
  /** 终端宽度 */
  terminalWidth: number;
  /** 终端高度 */
  terminalHeight: number;
  /** 前缀缩进（与 MessageRenderer 的 assistant prefix 对齐） */
  prefixIndent: number;
  /** 是否为首次渲染（需要输出前缀） */
  isFirstRender: boolean;
}

const state: RawRendererState = {
  active: false,
  renderedLineCount: 0,
  lastRenderedLines: [],
  terminalWidth: process.stdout.columns || 80,
  terminalHeight: process.stdout.rows || 24,
  prefixIndent: 4, // "• " + marginRight(1) = 4 chars
  isFirstRender: true,
};

// ANSI escape sequences
const ESC = '\x1b';
const ERASE_LINE = `${ESC}[2K`;
const CURSOR_UP = (n: number) => (n > 0 ? `${ESC}[${n}A` : '');
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * 激活 raw renderer
 */
export function activateRawRenderer(terminalWidth: number, terminalHeight: number): void {
  state.active = true;
  state.renderedLineCount = 0;
  state.lastRenderedLines = [];
  state.terminalWidth = terminalWidth;
  state.terminalHeight = terminalHeight;
  state.isFirstRender = true;
}

/**
 * 更新终端尺寸
 */
export function updateRawRendererSize(
  terminalWidth: number,
  terminalHeight: number
): void {
  state.terminalWidth = terminalWidth;
  state.terminalHeight = terminalHeight;
}

/**
 * 渲染流式 tail 内容
 *
 * @param lines - 当前 tail 的文本行
 * @param hiddenLines - 被隐藏的行数（视窗之上）
 * @param mode - streaming 模式（text/code/diff/table）
 * @param hidePrefix - 是否隐藏前缀（已有 blocks 在上方）
 */
export function renderTail(
  lines: string[],
  hiddenLines: number,
  mode: 'text' | 'code' | 'diff' | 'table',
  hidePrefix: boolean
): void {
  if (!state.active) return;

  const RESERVED_LINES = 8; // 给输入框、状态栏等留空间
  const maxDisplayLines = Math.max(1, state.terminalHeight - RESERVED_LINES);

  // 构建要渲染的行
  const outputLines: string[] = [];
  const theme = themeManager.getTheme();
  const indent = ' '.repeat(state.prefixIndent);

  // 隐藏行提示
  if (hiddenLines > 0) {
    outputLines.push(
      `${indent}${chalk.dim.hex(theme.colors.text.muted)(`^ ${hiddenLines} lines above (streaming...)`)}`
    );
  }

  // 内容行
  const visibleLines = lines.slice(-maxDisplayLines);
  for (let i = 0; i < visibleLines.length; i++) {
    const line = visibleLines[i];
    let prefix = indent;

    // 首行前缀
    if (i === 0 && !hidePrefix && state.isFirstRender) {
      prefix = chalk.bold.hex(theme.colors.success)('• ') + ' ';
      state.isFirstRender = false;
    }

    // 截断超宽行
    const maxContentWidth = state.terminalWidth - state.prefixIndent - 2;
    let displayLine = line;
    if (stringWidth(line) > maxContentWidth) {
      // 简单截断（不处理 ANSI，因为 tail 是纯文本）
      displayLine = line.slice(0, maxContentWidth);
    }

    outputLines.push(`${prefix}${displayLine}`);
  }

  // 差量渲染：对比上一帧，只更新变化的行
  const buf: string[] = [];
  buf.push(HIDE_CURSOR);

  if (state.renderedLineCount > 0) {
    // 光标回到 raw 区域起始位置
    buf.push(CURSOR_UP(state.renderedLineCount));
    buf.push('\r');
  }

  // 逐行输出
  for (let i = 0; i < outputLines.length; i++) {
    const newLine = outputLines[i];
    const oldLine = state.lastRenderedLines[i];

    if (newLine !== oldLine) {
      // 行内容变化，清除整行后写入新内容
      buf.push(ERASE_LINE);
      buf.push(newLine);
    }

    if (i < outputLines.length - 1) {
      buf.push('\n');
    }
  }

  // 如果新帧行数少于旧帧，清除多余的行
  if (outputLines.length < state.renderedLineCount) {
    for (let i = outputLines.length; i < state.renderedLineCount; i++) {
      buf.push('\n');
      buf.push(ERASE_LINE);
    }
    // 光标回到最后一行内容末尾
    const excess = state.renderedLineCount - outputLines.length;
    buf.push(CURSOR_UP(excess));
  }

  buf.push(SHOW_CURSOR);

  // 一次性写入（最小化终端 I/O）
  process.stdout.write(buf.join(''));

  // 更新状态
  state.renderedLineCount = outputLines.length;
  state.lastRenderedLines = outputLines;
}

/**
 * 清除 raw 区域并停用
 */
export function clearRawRenderer(): void {
  if (!state.active) return;

  if (state.renderedLineCount > 0) {
    const buf: string[] = [];
    buf.push(HIDE_CURSOR);

    // 回到 raw 区域起始
    buf.push(CURSOR_UP(state.renderedLineCount));
    buf.push('\r');

    // 逐行清除
    for (let i = 0; i < state.renderedLineCount; i++) {
      buf.push(ERASE_LINE);
      if (i < state.renderedLineCount - 1) {
        buf.push('\n');
      }
    }

    // 回到起始位置
    if (state.renderedLineCount > 1) {
      buf.push(CURSOR_UP(state.renderedLineCount - 1));
      buf.push('\r');
    }

    buf.push(SHOW_CURSOR);
    process.stdout.write(buf.join(''));
  }

  state.active = false;
  state.renderedLineCount = 0;
  state.lastRenderedLines = [];
  state.isFirstRender = true;
}

/**
 * 检查是否处于活动状态
 */
export function isRawRendererActive(): boolean {
  return state.active;
}

/**
 * 获取当前 raw 区域占用的行数
 */
export function getRawRendererLineCount(): number {
  return state.renderedLineCount;
}
