/**
 * useTheme Hook
 * 提供主题访问和管理功能
 */

import { useState } from 'react';
import { themeManager } from '../themes/ThemeManager.js';
import type { Theme } from '../themes/types.js';

/**
 * 主题 Hook
 * @returns 当前主题和主题管理方法
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(themeManager.getTheme());
  const [themeName, setThemeName] = useState<string>(
    themeManager.getCurrentThemeName()
  );

  // 切换主题
  const changeTheme = (newThemeName: string) => {
    try {
      themeManager.setTheme(newThemeName);
      setTheme(themeManager.getTheme());
      setThemeName(newThemeName);
    } catch (error) {
      console.error('Failed to change theme:', error);
    }
  };

  // 获取所有可用主题
  const availableThemes = themeManager.getAvailableThemes();

  // 检查主题是否存在
  const hasTheme = (name: string) => themeManager.hasTheme(name);

  // 通过名称获取主题
  const getThemeByName = (name: string) => themeManager.getThemeByName(name);

  return {
    theme,
    themeName,
    changeTheme,
    availableThemes,
    hasTheme,
    getThemeByName,
    // 快捷访问颜色
    colors: theme.colors,
    spacing: theme.spacing,
    typography: theme.typography,
  };
}

/**
 * 简化版 Hook - 只返回颜色
 * 适用于大多数组件
 */
export function useThemeColors() {
  const { colors } = useTheme();
  return colors;
}
