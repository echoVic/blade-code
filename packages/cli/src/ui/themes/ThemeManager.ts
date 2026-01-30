/**
 * 核心主题管理器
 */

import { themes } from './presets.js';
import type { BaseColors, Theme } from './types.js';

// 默认主题配置
const defaultColors: BaseColors = {
  primary: '#0066cc',
  secondary: '#6c757d',
  accent: '#e83e8c',
  success: '#28a745',
  warning: '#ffc107',
  error: '#dc3545',
  info: '#17a2b8',
  light: '#f8f9fa',
  dark: '#343a40',
  muted: '#6c757d',
  highlight: '#fff3cd',
  text: {
    primary: '#212529',
    secondary: '#6c757d',
    muted: '#6c757d',
    light: '#ffffff',
  },
  background: {
    primary: '#ffffff',
    secondary: '#f8f9fa',
    dark: '#343a40',
  },
  border: {
    light: '#dee2e6',
    dark: '#495057',
  },
  syntax: {
    comment: '#6c757d',
    string: '#28a745',
    number: '#e83e8c',
    keyword: '#007bff',
    function: '#17a2b8',
    variable: '#495057',
    operator: '#ffc107',
    type: '#007bff',
    tag: '#dc3545',
    attr: '#ffc107',
    default: '#212529',
  },
};

const defaultTheme: Theme = {
  name: 'default',
  colors: defaultColors,
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    base: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  },
};

// 暗色主题配置
const darkTheme: Theme = {
  ...defaultTheme,
  name: 'dark',
  colors: {
    ...defaultColors,
    text: {
      primary: '#ffffff',
      secondary: '#e2e8f0',
      muted: '#94a3b8',
      light: '#000000',
    },
    background: {
      primary: '#1e293b',
      secondary: '#334155',
      dark: '#0f172a',
    },
    border: {
      light: '#475569',
      dark: '#64748b',
    },
    syntax: {
      comment: '#94a3b8',
      string: '#34d399',
      number: '#f472b6',
      keyword: '#60a5fa',
      function: '#06b6d4',
      variable: '#e2e8f0',
      operator: '#fbbf24',
      type: '#60a5fa',
      tag: '#fb7185',
      attr: '#fbbf24',
      default: '#ffffff',
    },
  },
};

// 主题管理器类
class ThemeManager {
  private currentTheme: Theme = defaultTheme;
  private themes: Map<string, Theme> = new Map();

  constructor() {
    this.themes.set('default', defaultTheme);
    this.themes.set('dark', darkTheme);

    // 注册所有预设主题 (themes 现在是数组)
    for (const item of themes) {
      this.themes.set(item.id, item.theme);
    }
  }

  /**
   * 设置当前主题
   * @param themeName 主题名称
   */
  setTheme(themeName: string): void {
    const theme = this.themes.get(themeName);
    if (theme) {
      this.currentTheme = theme;
    } else {
      throw new Error(`Theme '${themeName}' not found`);
    }
  }

  /**
   * 获取当前主题
   * @returns 当前主题配置
   */
  getTheme(): Theme {
    return this.currentTheme;
  }

  /**
   * 获取所有可用主题名称
   * @returns 主题名称数组
   */
  getAvailableThemes(): string[] {
    return Array.from(this.themes.keys());
  }

  /**
   * 获取当前主题名称
   * @returns 当前主题名称
   */
  getCurrentThemeName(): string {
    return this.currentTheme.name;
  }

  /**
   * 通过名称获取主题
   * @param name 主题名称
   * @returns 主题配置或undefined
   */
  getThemeByName(name: string): Theme | undefined {
    return this.themes.get(name);
  }

  /**
   * 检查主题是否存在
   * @param name 主题名称
   * @returns 是否存在
   */
  hasTheme(name: string): boolean {
    return this.themes.has(name);
  }
}

// 导出默认主题管理器实例
export const themeManager = new ThemeManager();
