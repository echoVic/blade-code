/**
 * 主题类型定义
 */

// 语法高亮颜色配置
export interface SyntaxColors {
  comment: string;
  string: string;
  number: string;
  keyword: string;
  function: string;
  variable: string;
  operator: string;
  type: string;
  tag: string;
  attr: string;
  default: string;
}

// 基础颜色配置
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

  // 语法高亮颜色
  syntax: SyntaxColors;
}

// 主题完整配置
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
