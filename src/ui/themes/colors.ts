/**
 * UI颜色主题配置
 */

export const UIColors = {
  // 主要颜色
  primary: '#0066cc',
  secondary: '#6c757d',

  // 状态颜色
  success: '#28a745',
  warning: '#ffc107',
  error: '#dc3545',
  info: '#17a2b8',

  // 灰度颜色
  light: '#f8f9fa',
  dark: '#343a40',
  muted: '#6c757d',

  // 文本颜色
  text: {
    primary: '#212529',
    secondary: '#6c757d',
    muted: '#6c757d',
    light: '#ffffff',
  },

  // 背景颜色
  background: {
    primary: '#ffffff',
    secondary: '#f8f9fa',
    dark: '#343a40',
  },

  // 边框颜色
  border: {
    light: '#dee2e6',
    dark: '#495057',
  },

  // 特殊用途颜色
  accent: '#e83e8c',
  highlight: '#fff3cd',
} as const;

export type UIColorKey = keyof typeof UIColors;
