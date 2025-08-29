/**
 * 主题定义和工具函数
 */

// 基础颜色类型
export interface BaseColors {
  // 主要颜色
  primary: string;
  secondary: string;
  accent: string;
  
  // 状态颜色
  success: string;
  warning: string;
  error: string;
  info: string;
  
  // 灰度颜色
  light: string;
  dark: string;
  muted: string;
  
  // 文本颜色
  text: {
    primary: string;
    secondary: string;
    muted: string;
    light: string;
  };
  
  // 背景颜色
  background: {
    primary: string;
    secondary: string;
    dark: string;
  };
  
  // 边框颜色
  border: {
    light: string;
    dark: string;
  };
  
  // 特殊用途颜色
  highlight: string;
}

// 主题配置接口
export interface Theme {
  name: string;
  colors: BaseColors;
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  typography: {
    fontSize: {
      xs: number;
      sm: number;
      base: number;
      lg: number;
      xl: number;
      '2xl': number;
      '3xl': number;
    };
    fontWeight: {
      light: number;
      normal: number;
      medium: number;
      semibold: number;
      bold: number;
    };
  };
  borderRadius: {
    sm: number;
    base: number;
    lg: number;
    xl: number;
  };
  boxShadow: {
    sm: string;
    base: string;
    lg: string;
  };
}

// 主题验证函数
export function validateTheme(theme: any): theme is Theme {
  // 检查必需的属性
  if (!theme || typeof theme !== 'object') {
    return false;
  }
  
  if (!theme.name || typeof theme.name !== 'string') {
    return false;
  }
  
  // 检查颜色配置
  if (!theme.colors || typeof theme.colors !== 'object') {
    return false;
  }
  
  const requiredColorKeys = [
    'primary', 'secondary', 'accent', 'success', 'warning', 
    'error', 'info', 'light', 'dark', 'muted', 'highlight'
  ];
  
  for (const key of requiredColorKeys) {
    if (!theme.colors[key] || typeof theme.colors[key] !== 'string') {
      return false;
    }
  }
  
  // 检查嵌套对象
  if (!theme.colors.text || typeof theme.colors.text !== 'object') {
    return false;
  }
  
  if (!theme.colors.background || typeof theme.colors.background !== 'object') {
    return false;
  }
  
  if (!theme.colors.border || typeof theme.colors.border !== 'object') {
    return false;
  }
  
  const requiredTextKeys = ['primary', 'secondary', 'muted', 'light'];
  const requiredBgKeys = ['primary', 'secondary', 'dark'];
  const requiredBorderKeys = ['light', 'dark'];
  
  for (const key of requiredTextKeys) {
    if (!theme.colors.text[key] || typeof theme.colors.text[key] !== 'string') {
      return false;
    }
  }
  
  for (const key of requiredBgKeys) {
    if (!theme.colors.background[key] || typeof theme.colors.background[key] !== 'string') {
      return false;
    }
  }
  
  for (const key of requiredBorderKeys) {
    if (!theme.colors.border[key] || typeof theme.colors.border[key] !== 'string') {
      return false;
    }
  }
  
  // 检查其他配置
  if (!theme.spacing || typeof theme.spacing !== 'object') {
    return false;
  }
  
  if (!theme.typography || typeof theme.typography !== 'object') {
    return false;
  }
  
  if (!theme.borderRadius || typeof theme.borderRadius !== 'object') {
    return false;
  }
  
  if (!theme.boxShadow || typeof theme.boxShadow !== 'object') {
    return false;
  }
  
  return true;
}

// 颜色混合函数
export function blendColors(color1: string, color2: string, ratio: number): string {
  // 移除 # 前缀
  const c1 = color1.replace('#', '');
  const c2 = color2.replace('#', '');
  
  // 解析 RGB 值
  const r1 = parseInt(c1.substring(0, 2), 16);
  const g1 = parseInt(c1.substring(2, 4), 16);
  const b1 = parseInt(c1.substring(4, 6), 16);
  
  const r2 = parseInt(c2.substring(0, 2), 16);
  const g2 = parseInt(c2.substring(2, 4), 16);
  const b2 = parseInt(c2.substring(4, 6), 16);
  
  // 混合颜色
  const r = Math.round(r1 * (1 - ratio) + r2 * ratio);
  const g = Math.round(g1 * (1 - ratio) + g2 * ratio);
  const b = Math.round(b1 * (1 - ratio) + b2 * ratio);
  
  // 转换回十六进制
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// 颜色亮度计算
export function getColorBrightness(color: string): number {
  const c = color.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  
  // 使用相对亮度公式
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// 生成对比色
export function getContrastColor(color: string): string {
  const brightness = getColorBrightness(color);
  return brightness > 0.5 ? '#000000' : '#ffffff';
}