/**
 * Ink Box 组件 - 布局容器
 * 适配Blade UI主题系统
 */
import { Box as InkBox } from 'ink';
import React from 'react';
import { toNumber } from 'lodash-es';
// 临时类型定义
type SpacingTokens = string;

interface BoxProps {
  /**
   * 子元素
   */
  children: React.ReactNode;
  /**
   * Flex方向
   */
  flexDirection?: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  /**
   * Gap间距
   */
  gap?: number | string;
  /**
   * 主轴对齐方式
   */
  justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'space-between'
    | 'space-around';
  /**
   * 交叉轴对齐方式
   */
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch';
  /**
   * 多行内容对齐方式
   */
  alignContent?:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'space-between'
    | 'space-around'
    | 'stretch';
  /**
   * Flex增长因子
   */
  flexGrow?: number;
  /**
   * Flex收缩因子
   */
  flexShrink?: number;
  /**
   * Flex基础大小
   */
  flexBasis?: number | string;
  /**
   * Flex换行
   */
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  /**
   * 宽度
   */
  width?: number | string;
  /**
   * 高度
   */
  height?: number | string;
  /**
   * 最小宽度
   */
  minWidth?: number | string;
  /**
   * 最小高度
   */
  minHeight?: number | string;
  /**
   * 最大宽度
   */
  maxWidth?: number | string;
  /**
   * 最大高度
   */
  maxHeight?: number | string;
  /**
   * 内边距
   */
  padding?: number | string;
  /**
   * X轴内边距
   */
  paddingX?: number | string;
  /**
   * Y轴内边距
   */
  paddingY?: number | string;
  /**
   * 上内边距
   */
  paddingTop?: number | string;
  /**
   * 下内边距
   */
  paddingBottom?: number | string;
  /**
   * 左内边距
   */
  paddingLeft?: number | string;
  /**
   * 右内边距
   */
  paddingRight?: number | string;
  /**
   * 外边距
   */
  margin?: number | string;
  /**
   * X轴外边距
   */
  marginX?: number | string;
  /**
   * Y轴外边距
   */
  marginY?: number | string;
  /**
   * 上外边距
   */
  marginTop?: number | string;
  /**
   * 下外边距
   */
  marginBottom?: number | string;
  /**
   * 左外边距
   */
  marginLeft?: number | string;
  /**
   * 右外边距
   */
  marginRight?: number | string;
  /**
   * 边框样式
   */
  borderStyle?: 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic';
  /**
   * 边框颜色 - 支持主题令牌路径或直接颜色值
   */
  borderColor?: string;
  /**
   * 背景颜色 - 支持主题令牌路径或直接颜色值
   */
  backgroundColor?: string;
  /**
   * 显示方式
   */
  display?: 'flex' | 'none';
  /**
   * 自定义样式
   */
  style?: React.CSSProperties;
  /**
   * 样式变体
   */
  variant?: 'card' | 'section' | 'container' | 'flex' | 'inline';
  /**
   * 点击事件
   */
  onPress?: () => void;
  /**
   * 鼠标进入事件
   */
  onMouseEnter?: () => void;
  /**
   * 鼠标离开事件
   */
  onMouseLeave?: () => void;
}

export const Box: React.FC<BoxProps> = ({
  children,
  flexDirection = 'row',
  justifyContent = 'flex-start',
  alignItems = 'stretch',
  alignContent = 'flex-start',
  flexGrow = 0,
  flexShrink = 1,
  flexBasis = 'auto',
  flexWrap = 'nowrap',
  width,
  height,
  minWidth,
  minHeight,
  maxWidth,
  maxHeight,
  padding,
  paddingX,
  paddingY,
  paddingTop,
  paddingBottom,
  paddingLeft,
  paddingRight,
  margin,
  marginX,
  marginY,
  marginTop,
  marginBottom,
  marginLeft,
  marginRight,
  borderStyle,
  borderColor,
  backgroundColor,
  display = 'flex',
  style,
  variant,
}) => {
  // 使用 lodash-es 的 toNumber 函数进行类型转换
  const convertToNumber = (value: string | number | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const converted = toNumber(value);
    return isNaN(converted) ? undefined : converted;
  };

  // 根据变体获取默认样式
  const getVariantStyles = () => {
    // 这里应该从主题上下文中获取样式
    // 暂时返回固定值，实际实现中需要接入主题系统
    const variantStyles: Record<string, React.CSSProperties> = {
      card: {
        padding: 1,
        borderStyle: 'round',
        borderColor: '#D1D5DB',
        backgroundColor: '#FFFFFF',
      },
      section: {
        padding: 1,
      },
      container: {
        padding: 1,
      },
      flex: {
        display: 'flex',
      },
      inline: {
        display: 'inline-flex',
      },
    };

    return variantStyles[variant || 'flex'] || {};
  };

  // 获取变体样式
  const variantStyles = getVariantStyles();

  // 构建样式对象
  const boxStyle: React.CSSProperties = {
    flexDirection,
    justifyContent,
    alignItems: alignItems === 'baseline' ? 'flex-start' : alignItems,
    alignContent,
    flexGrow,
    flexShrink,
    flexBasis,
    flexWrap,
    width,
    height,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    padding,
    paddingTop,
    paddingBottom,
    paddingLeft,
    paddingRight,
    margin,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    borderColor: borderColor || (variantStyles.borderColor as string),
    backgroundColor: backgroundColor || (variantStyles.backgroundColor as string),
    display,
    ...variantStyles, // 应用变体样式
    ...style, // 让自定义样式可以覆盖默认样式
  };

  return (
    <InkBox
      flexDirection={flexDirection}
      justifyContent={justifyContent}
      alignItems={alignItems === 'baseline' ? 'flex-start' : alignItems}
      flexWrap={flexWrap}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      flexBasis={flexBasis}
      width={width}
      height={height}
      minWidth={minWidth}
      minHeight={minHeight}
      padding={convertToNumber(padding)}
      paddingX={convertToNumber(paddingX)}
      paddingY={convertToNumber(paddingY)}
      paddingTop={convertToNumber(paddingTop)}
      paddingBottom={convertToNumber(paddingBottom)}
      paddingLeft={convertToNumber(paddingLeft)}
      paddingRight={convertToNumber(paddingRight)}
      margin={convertToNumber(margin)}
      marginX={convertToNumber(marginX)}
      marginY={convertToNumber(marginY)}
      marginTop={convertToNumber(marginTop)}
      marginBottom={convertToNumber(marginBottom)}
      marginLeft={convertToNumber(marginLeft)}
      marginRight={convertToNumber(marginRight)}
      borderStyle={borderStyle || (variantStyles.borderStyle as any)}
      borderColor={borderColor || (variantStyles.borderColor as string)}
      backgroundColor={backgroundColor || (variantStyles.backgroundColor as string)}
      display={display}
    >
      {children}
    </InkBox>
  );
};