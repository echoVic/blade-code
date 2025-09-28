/**
 * UI样式配置 - 基于现代化主题系统
 */
import chalk from 'chalk';
import { themeManager } from './theme-manager.js';

// 动态样式生成器
export const UIStyles = {
  // 文本样式
  text: {
    bold: (text: string) => chalk.bold(text),
    italic: (text: string) => chalk.italic(text),
    underline: (text: string) => chalk.underline(text),
    strikethrough: (text: string) => chalk.strikethrough(text),
    dim: (text: string) => chalk.dim(text),
  },

  // 状态样式
  status: {
    success: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.success)(text);
    },
    error: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.error)(text);
    },
    warning: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.warning)(text);
    },
    info: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.info)(text);
    },
    muted: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.muted)(text);
    },
  },

  // 语义化样式
  semantic: {
    primary: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.primary)(text);
    },
    secondary: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.secondary)(text);
    },
    accent: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.accent)(text);
    },
    highlight: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bgHex(theme.colors.highlight).hex(theme.colors.text.primary)(text);
    },
  },

  // 标题样式
  heading: {
    h1: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bold.hex(theme.colors.primary)(text);
    },
    h2: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bold.hex(theme.colors.info)(text);
    },
    h3: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bold.hex(theme.colors.success)(text);
    },
    h4: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bold.hex(theme.colors.warning)(text);
    },
  },

  // 特殊组件样式
  component: {
    header: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.bold.hex(theme.colors.primary)(text);
    },
    section: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.info)(text);
    },
    label: (text: string) => chalk.white(text),
    value: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.success)(text);
    },
    code: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.gray.bgHex(theme.colors.background.secondary)(` ${text} `);
    },
    quote: (text: string) => {
      const theme = themeManager.getTheme();
      return chalk.italic.hex(theme.colors.text.secondary)(text);
    },
  },

  // 图标样式
  icon: {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    loading: '⏳',
    rocket: '🚀',
    gear: '⚙️',
    chat: '💬',
    tools: '🔧',
    config: '📋',
    mcp: '🔗',
  },

  // 边框和分隔符
  border: {
    line: (length: number = 50) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.border.light)('─'.repeat(length));
    },
    doubleLine: (length: number = 50) => {
      const theme = themeManager.getTheme();
      return chalk.hex(theme.colors.border.dark)('═'.repeat(length));
    },
    box: {
      top: '┌',
      bottom: '└',
      left: '│',
      right: '│',
      horizontal: '─',
      vertical: '│',
    },
  },
} as const;

// 便捷方法
export const $ = {
  success: UIStyles.status.success,
  error: UIStyles.status.error,
  warning: UIStyles.status.warning,
  info: UIStyles.status.info,
  muted: UIStyles.status.muted,
  bold: UIStyles.text.bold,
  dim: UIStyles.text.dim,
  header: UIStyles.component.header,
  code: UIStyles.component.code,
};