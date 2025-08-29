/**
 * Ink Text 组件 - 终端文本渲染
 */
import { Text as InkText } from 'ink';
import React from 'react';

interface TextProps {
  children: React.ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
  wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
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
}) => {
  // 构建样式对象
  const textStyle: React.CSSProperties = {
    ...style,
    color,
    backgroundColor,
    fontWeight: bold ? 'bold' : 'normal',
    fontStyle: italic ? 'italic' : 'normal',
    textDecoration: [
      underline ? 'underline' : '',
      strikethrough ? 'line-through' : '',
    ]
      .filter(Boolean)
      .join(' '),
    opacity: dim ? 0.5 : 1,
  };

  return (
    <InkText
      color={color}
      backgroundColor={backgroundColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      dimColor={dim}
      wrap={wrap}
      style={textStyle}
    >
      {children}
    </InkText>
  );
};