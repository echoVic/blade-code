/**
 * 主题系统统一导出
 */

// 类型定义
export type { Theme, BaseColors } from './types.js';

// 核心管理器
export { ThemeManager, themeManager, defaultTheme, darkTheme } from './theme-manager.js';

// 主题预设
export { themes, THEME_NAMES } from './presets.js';

// 工具函数
export { validateTheme, blendColors, getColorBrightness, getContrastColor } from './utils.js';

// 语义化颜色
export { SemanticColorManager, type SemanticColorMapping } from './semantic-colors.js';

// UI 样式和颜色（保持向后兼容）
export { UIColors } from './colors.js';
export { UIStyles, $ } from './styles.js';
