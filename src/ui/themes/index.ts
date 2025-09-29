/**
 * 主题系统统一导出
 */

// UI 样式和颜色（保持向后兼容）
export { UIColors } from './colors.js';
// 主题预设
export { THEME_NAMES, themes } from './presets.js';
// 语义化颜色
export { SemanticColorManager, type SemanticColorMapping } from './semantic-colors.js';
export { $, UIStyles } from './styles.js';
// 核心管理器
export {
  darkTheme,
  defaultTheme,
  ThemeManager,
  themeManager,
} from './theme-manager.js';
// 类型定义
export type { BaseColors, Theme } from './types.js';
// 工具函数
export {
  blendColors,
  getColorBrightness,
  getContrastColor,
  validateTheme,
} from './utils.js';
