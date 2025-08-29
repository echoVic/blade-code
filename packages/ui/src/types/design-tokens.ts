/**
 * 设计令牌核心类型定义
 * 基于Design Tokens Community Group标准
 */

import type { DeepRequired, DeepPartial } from '../../types/utils';

// 基础设计令牌类型
export interface DesignTokens {
  // 颜色令牌
  colors: ColorTokens;
  
  // 排版令牌
  typography: TypographyTokens;
  
  // 间距令牌
  spacing: SpacingTokens;
  
  // 边框令牌
  border: BorderTokens;
  
  // 阴影令牌
  shadow: ShadowTokens;
  
  // 动画令牌
  animation: AnimationTokens;
  
  // 布局令牌
  layout: LayoutTokens;
  
  // 渐变令牌
  gradient: GradientTokens;
}

// 颜色令牌系统
export interface ColorTokens {
  // 基础颜色
  base: {
    white: string;
    black: string;
    gray: ColorPalette;
    neutral: ColorPalette;
  };
  
  // 语义化颜色
  semantic: {
    primary: ColorScale;
    secondary: ColorScale;
    accent: ColorScale;
    success: ColorScale;
    warning: ColorScale;
    error: ColorScale;
    info: ColorScale;
  };
  
  // 功能性颜色
  functional: {
    background: BackgroundColors;
    text: TextColors;
    border: BorderColors;
    icon: IconColors;
    interactive: InteractiveColors;
  };
  
  // 主题颜色
  theme: {
    light: ThemeColors;
    dark: ThemeColors;
  };
}

// 颜色色阶
export interface ColorScale {
  50: string;   // 最浅
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;  // 主色
  600: string;
  700: string;
  800: string;
  900: string;  // 最深
}

// 颜色调色板
export interface ColorPalette {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
}

// 背景颜色
export interface BackgroundColors {
  primary: string;
  secondary: string;
  tertiary: string;
  surface: string;
  hover: string;
  active: string;
  disabled: string;
  overlay: string;
}

// 文本颜色
export interface TextColors {
  primary: string;
  secondary: string;
  tertiary: string;
  inverse: string;
  disabled: string;
  link: string;
  code: string;
}

// 边框颜色
export interface BorderColors {
  default: string;
  hover: string;
  focus: string;
  interactive: string;
  disabled: string;
}

// 图标颜色
export interface IconColors {
  primary: string;
  secondary: string;
  inverse: string;
  disabled: string;
  active: string;
}

// 交互颜色
export interface InteractiveColors {
  hover: string;
  active: string;
  focus: string;
  selected: string;
  disabled: string;
}

// 主题颜色
export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  subtext: string;
  border: string;
  divider: string;
  highlight: string;
  shadow: string;
}

// 排版令牌系统
export interface TypographyTokens {
  // 字体族
  fontFamily: {
    sans: string[];
    serif: string[];
    mono: string[];
    display: string[];
  };
  
  // 字体大小
  fontSize: {
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
    '4xl': number;
    '5xl': number;
    '6xl': number;
  };
  
  // 字体粗细
  fontWeight: {
    thin: number;
    light: number;
    normal: number;
    medium: number;
    semibold: number;
    bold: number;
    black: number;
  };
  
  // 行高
  lineHeight: {
    none: number;
    tight: number;
    snuggly: number;
    normal: number;
    relaxed: number;
    loose: number;
  };
  
  // 字母间距
  letterSpacing: {
    tight: string;
    normal: string;
    wide: string;
  };
  
  // 文本对齐
  textAlign: {
    left: string;
    center: string;
    right: string;
    justify: string;
  };
  
  // 文本转换
  textTransform: {
    none: string;
    uppercase: string;
    lowercase: string;
    capitalize: string;
  };
  
  // 文本装饰
  textDecoration: {
    none: string;
    underline: string;
    lineThrough: string;
    underlineLineThrough: string;
  };
}

// 间距令牌系统
export interface SpacingTokens {
  // 基础间距
  base: {
    none: number;
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
    '4xl': number;
    '5xl': number;
    '6xl': number;
  };
  
  // 组件间距
  component: {
    padding: {
      xs: number;
      sm: number;
      md: number;
      lg: number;
      xl: number;
    };
    margin: {
      xs: number;
      sm: number;
      md: number;
      lg: number;
      xl: number;
    };
    gap: {
      xs: number;
      sm: number;
      md: number;
      lg: number;
      xl: number;
    };
  };
  
  // 响应式间距
  responsive: {
    phone: number;
    tablet: number;
    desktop: number;
    widescreen: number;
  };
}

// 边框令牌系统
export interface BorderTokens {
  // 边框宽度
  width: {
    none: number;
    thin: number;
    normal: number;
    medium: number;
    thick: number;
  };
  
  // 边框样式
  style: {
    solid: string;
    dashed: string;
    dotted: string;
    double: string;
  };
  
  // 边框圆角
  radius: {
    none: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
    full: number;
  };
  
  // 边框颜色权重
  opacity: {
    light: number;
    normal: number;
    heavy: number;
  };
}

// 阴影令牌系统
export interface ShadowTokens {
  // 盒子阴影
  box: {
    none: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    '2xl': string;
    inner: string;
  };
  
  // 文本阴影
  text: {
    none: string;
    sm: string;
    md: string;
    lg: string;
  };
  
  // 阴影颜色
  colors: {
    ambient: string;
    light: string;
    dark: string;
    color: string;
  };
}

// 动画令牌系统
export interface AnimationTokens {
  // 持续时间
  duration: {
    fastest: number;
    fast: number;
    normal: number;
    slow: number;
    slowest: number;
  };
  
  // 缓动函数
  easing: {
    linear: string;
    easeIn: string;
    easeOut: string;
    easeInOut: string;
    bounceIn: string;
    bounceOut: string;
    elasticIn: string;
    elasticOut: string;
  };
  
  // 延迟
  delay: {
    none: number;
    xs: number;
    sm: number;
    md: number;
    lg: number;
  };
  
  // 动画类型
  type: {
    fadeIn: string;
    fadeOut: string;
    slideIn: string;
    slideOut: string;
    scaleIn: string;
    scaleOut: string;
    rotateIn: string;
    rotateOut: string;
  };
}

// 布局令牌系统
export interface LayoutTokens {
  // 断点
  breakpoints: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    '2xl': number;
  };
  
  // 容器宽度
  container: {
    sm: number;
    md: number;
    lg: number;
    xl: number;
    full: number;
  };
  
  // 网格系统
  grid: {
    columns: number;
    gutter: number;
    maxWidth: number;
  };
  
  // 栅格系统
  columns: {
    1: number;
    2: number;
    3: number;
    4: number;
    6: number;
    8: number;
    12: number;
    24: number;
  };
}

// 渐变令牌系统
export interface GradientTokens {
  // 线性渐变
  linear: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    subtle: string;
    strong: string;
  };
  
  // 径向渐变
  radial: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    subtle: string;
    strong: string;
  };
  
  // 渐变方向
  directions: {
    toTop: string;
    toRight: string;
    toBottom: string;
    toLeft: string;
    toTopRight: string;
    toTopLeft: string;
    toBottomRight: string;
    toBottomLeft: string;
  };
}

// 主题配置接口
export interface ThemeConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  isDark: boolean;
  tokens: DeepRequired<DesignTokens>;
  customTokens?: Record<string, any>;
  components?: ComponentThemeConfig;
}

// 组件主题配置
export interface ComponentThemeConfig {
  // 组件特定的主题配置
  [componentName: string]: {
    // 组件样式配置
    style: Record<string, any>;
    // 变体配置
    variants?: Record<string, any>;
    // 状态配置
    states?: Record<string, any>;
    // 自定义属性
    custom?: Record<string, any>;
  };
}

// 主题模式
export interface ThemeMode {
  light: {
    name: string;
    colorScheme: 'light';
    tokens: DeepRequired<DesignTokens>;
  };
  dark: {
    name: string;
    colorScheme: 'dark';
    tokens: DeepRequired<DesignTokens>;
  };
}

// 主题变体
export interface ThemeVariant {
  id: string;
  name: string;
  description: string;
  tokens: DeepPartial<DesignTokens>;
  parentTheme: string;
}

// 主题预设
export interface ThemePreset {
  id: string;
  name: string;
  category: 'light' | 'dark' | 'system' | 'custom';
  description: string;
  author: string;
  tokens: DeepRequired<DesignTokens>;
  preview?: string;
  tags?: string[];
}

// 主题映射器类型
export interface ThemeMapper {
  // 将设计令牌映射到具体的CSS属性
  mapTokenToProperty(tokenPath: string): string;
  // 将设计令牌映射到具体的值
  mapTokenToValue(tokenPath: string): any;
  // 获取所有可用的令牌路径
  getAllTokenPaths(): string[];
}

// 主题生成器选项
export interface ThemeGeneratorOptions {
  sourceTokens: DeepPartial<DesignTokens>;
  targetFormat: 'css' | 'scss' | 'less' | 'json' | 'typescript';
  outputDirectory: string;
  fileName: string;
  includeVariables?: boolean;
  includeClasses?: boolean;
  customMapping?: Record<string, string>;
}

// 主题验证结果
export interface ThemeValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  recommendations: ValidationRecommendation[];
}

// 验证错误
export interface ValidationError {
  type: 'required' | 'type' | 'format' | 'range' | 'custom';
  path: string;
  message: string;
  value: any;
  expected?: any;
}

// 验证警告
export interface ValidationWarning {
  type: 'deprecated' | 'unknown' | 'performance' | 'accessibility';
  path: string;
  message: string;
  suggestion?: string;
}

// 验证建议
export interface ValidationRecommendation {
  type: 'optimize' | 'improve' | 'standardize' | 'document';
  path: string;
  message: string;
  priority: 'low' | 'medium' | 'high';
}

// 导出类型
export type {
  DeepRequired,
  DeepPartial,
};