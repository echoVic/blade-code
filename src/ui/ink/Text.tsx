/**
 * Ink Text 组件 - 终端文本渲染
 * 适配Blade UI主题系统
 */
import { Text as InkText } from 'ink';
import React from 'react';

// 临时类型定义
type ColorScale = string;
type TextColors = string;

interface TextProps {
  children?: React.ReactNode;
  /**
   * 颜色值 - 支持主题令牌路径或直接颜色值
   * @example 'colors.semantic.primary.500' | '#FF0000'
   */
  color?: string;
  /**
   * 背景色值 - 支持主题令牌路径或直接颜色值
   */
  backgroundColor?: string;
  /**
   * 是否加粗
   */
  bold?: boolean;
  /**
   * 是否斜体
   */
  italic?: boolean;
  /**
   * 是否下划线
   */
  underline?: boolean;
  /**
   * 是否删除线
   */
  strikethrough?: boolean;
  /**
   * 是否淡化
   */
  dim?: boolean;
  /**
   * 文本换行方式
   */
  wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
  /**
   * 文本变体样式
   */
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';
  /**
   * 左边距
   */
  marginLeft?: number;
  /**
   * 上边距
   */
  marginTop?: number;
}

export const Text: React.FC<TextProps> = ({
  children,
  color,
  backgroundColor,
  bold,
  italic,
  underline,
  strikethrough,
  dim,
  wrap = 'wrap',
  variant,
}) => {
  // 根据变体获取颜色
  const getVariantColor = (): string | undefined => {
    if (!variant) return undefined;

    // 这里应该从主题上下文中获取颜色
    // 暂时返回固定值，实际实现中需要接入主题系统
    const variantColors: Record<string, string> = {
      primary: '#3B82F6',
      secondary: '#6B7280',
      success: '#22C55E',
      warning: '#F59E0B',
      error: '#EF4444',
      info: '#3B82F6',
    };

    return variantColors[variant];
  };

  // 确定最终颜色
  const finalColor = color || getVariantColor();

  // 构建样式对象
  const textStyle: React.CSSProperties = {
    color: finalColor,
    backgroundColor,
    fontWeight: bold ? 'bold' : 'normal',
    fontStyle: italic ? 'italic' : 'normal',
    textDecoration: [underline ? 'underline' : '', strikethrough ? 'line-through' : '']
      .filter(Boolean)
      .join(' '),
    opacity: dim ? 0.5 : 1,
  };

  return (
    <InkText
      color={finalColor}
      backgroundColor={backgroundColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      dimColor={dim}
      wrap={wrap}
    >
      {children}
    </InkText>
  );
};
