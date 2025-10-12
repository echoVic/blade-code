/**
 * 主题系统统一导出
 */

// 主题预设
export { THEME_NAMES, themes } from './presets.js';

// 核心管理器
export {
  darkTheme,
  defaultTheme,
  ThemeManager,
  themeManager,
} from './theme-manager.js';

// 类型定义
export type { BaseColors, SyntaxColors, Theme } from './types.js';

// 工具函数
export {
  blendColors,
  getColorBrightness,
  getContrastColor,
  validateTheme,
} from './utils.js';
