/**
 * Ink Button 组件 - 终端按钮
 * 适配Blade UI主题系统
 */
import React, { useCallback, useState } from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface ButtonProps {
  /**
   * 按钮内容
   */
  children: React.ReactNode;
  /**
   * 点击事件处理函数
   */
  onPress?: () => void;
  /**
   * 文本颜色 - 支持主题令牌路径或直接颜色值
   */
  color?: string;
  /**
   * 背景颜色 - 支持主题令牌路径或直接颜色值
   */
  backgroundColor?: string;
  /**
   * 边框颜色 - 支持主题令牌路径或直接颜色值
   */
  borderColor?: string;
  /**
   * 是否禁用
   */
  disabled?: boolean;
  /**
   * 是否聚焦
   */
  focus?: boolean;
  /**
   * 自定义样式
   */
  style?: React.CSSProperties;
  /**
   * 按钮变体
   */
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'ghost';
  /**
   * 按钮尺寸
   */
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onPress,
  color,
  backgroundColor,
  borderColor,
  disabled = false,
  focus = false,
  style,
  variant = 'primary',
  size = 'md',
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handlePress = useCallback(() => {
    if (!disabled && onPress) {
      onPress();
    }
  }, [disabled, onPress]);

  const handleMouseEnter = useCallback(() => {
    if (!disabled) {
      setIsHovered(true);
    }
  }, [disabled]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  // 根据变体获取样式
  const getVariantStyles = () => {
    // 这里应该从主题上下文中获取样式
    // 暂时返回固定值，实际实现中需要接入主题系统
    const variantStyles: Record<string, { color: string; backgroundColor: string; borderColor: string }> = {
      primary: {
        color: 'white',
        backgroundColor: '#3B82F6',
        borderColor: '#3B82F6',
      },
      secondary: {
        color: 'white',
        backgroundColor: '#6B7280',
        borderColor: '#6B7280',
      },
      success: {
        color: 'white',
        backgroundColor: '#22C55E',
        borderColor: '#22C55E',
      },
      warning: {
        color: 'white',
        backgroundColor: '#F59E0B',
        borderColor: '#F59E0B',
      },
      error: {
        color: 'white',
        backgroundColor: '#EF4444',
        borderColor: '#EF4444',
      },
      info: {
        color: 'white',
        backgroundColor: '#3B82F6',
        borderColor: '#3B82F6',
      },
      ghost: {
        color: '#3B82F6',
        backgroundColor: 'transparent',
        borderColor: '#3B82F6',
      },
    };

    return variantStyles[variant] || variantStyles.primary;
  };

  // 根据尺寸获取内边距
  const getSizePadding = () => {
    const paddingMap = {
      sm: { x: 1, y: 0 },
      md: { x: 2, y: 0 },
      lg: { x: 3, y: 1 },
    };
    return paddingMap[size] || paddingMap.md;
  };

  // 获取变体样式
  const variantStyles = getVariantStyles();
  const padding = getSizePadding();

  // 计算最终样式
  const finalColor = color || variantStyles.color;
  const finalBackgroundColor = disabled
    ? 'gray'
    : isHovered || focus
    ? variant === 'ghost' ? '#EFF6FF' : lightenColor(variantStyles.backgroundColor)
    : backgroundColor || variantStyles.backgroundColor;
  const finalBorderColor = disabled 
    ? 'gray' 
    : borderColor || variantStyles.borderColor;

  return (
    <Box
      onPress={handlePress}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      borderColor={finalBorderColor}
      borderStyle="round"
      paddingX={padding.x}
      paddingY={padding.y}
      backgroundColor={finalBackgroundColor}
      style={style}
    >
      <Text color={finalColor} bold>
        {children}
      </Text>
    </Box>
  );
};

// 简单的颜色变亮函数
function lightenColor(color: string): string {
  if (color.startsWith('#')) {
    // 简单的变亮逻辑
    return color;
  }
  return color;
}