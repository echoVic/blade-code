/**
 * Ink Layout 组件 - 响应式布局系统
 */
import React, { useState, useEffect } from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';
import { themeManager } from '../themes/theme-manager.js';
import { UIStyles } from '../themes/styles.js';

interface LayoutProps {
  children?: React.ReactNode;
  type?: 'header' | 'footer' | 'sidebar' | 'card' | 'panel' | 'grid' | 'divider';
  title?: string;
  subtitle?: string;
  width?: number;
  padding?: number;
  margin?: number;
  border?: boolean;
  borderColor?: string;
  backgroundColor?: string;
  align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties;
}

export const Layout: React.FC<LayoutProps> = ({
  children,
  type = 'panel',
  title,
  subtitle,
  width = 80,
  padding = 1,
  margin = 0,
  border = false,
  borderColor,
  backgroundColor,
  align = 'left',
  style,
}) => {
  const [theme, setTheme] = useState(() => themeManager.getTheme());
  const [terminalWidth, setTerminalWidth] = useState(width);

  // 监听主题和终端尺寸变化
  useEffect(() => {
    const handleThemeChange = () => {
      setTheme(themeManager.getTheme());
    };

    const handleResize = () => {
      // 获取终端实际宽度
      const terminalCols = process.stdout.columns || width;
      setTerminalWidth(Math.min(terminalCols, width));
    };

    handleThemeChange();
    handleResize();

    // 监听终端尺寸变化
    process.stdout.on('resize', handleResize);

    return () => {
      process.stdout.removeListener('resize', handleResize);
    };
  }, [width]);

  // 居中文本
  const centerText = (text: string, lineWidth: number): string => {
    if (!text) return ' '.repeat(lineWidth);
    
    const padding = Math.max(0, lineWidth - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
  };

  // 对齐文本
  const alignText = (text: string, lineWidth: number, alignment: 'left' | 'center' | 'right'): string => {
    if (text.length >= lineWidth) {
      return text.substring(0, lineWidth);
    }

    const padding = lineWidth - text.length;

    switch (alignment) {
      case 'center':
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
      case 'right':
        return ' '.repeat(padding) + text;
      default: // left
        return text + ' '.repeat(padding);
    }
  };

  // 渲染不同类型的布局
  const renderLayout = () => {
    switch (type) {
      case 'header':
        return renderHeader();
      case 'footer':
        return renderFooter();
      case 'card':
        return renderCard();
      case 'divider':
        return renderDivider();
      default:
        return renderPanel();
    }
  };

  // 渲染头部
  const renderHeader = () => {
    const actualWidth = Math.min(terminalWidth, width);
    
    return (
      <Box flexDirection="column" marginBottom={1} style={style}>
        <Box height={1}><Text></Text></Box>
        {border && (
          <Text color={borderColor || theme.colors.border.dark}>
            {UIStyles.border.doubleLine(actualWidth)}
          </Text>
        )}
        {title && (
          <Box justifyContent="center" paddingX={padding} paddingY={1}>
            <Text color={theme.colors.primary} bold>
              {centerText(title, actualWidth - padding * 2)}
            </Text>
          </Box>
        )}
        {subtitle && (
          <Box justifyContent="center" paddingX={padding}>
            <Text color={theme.colors.info}>
              {centerText(subtitle, actualWidth - padding * 2)}
            </Text>
          </Box>
        )}
        {border && (
          <Text color={borderColor || theme.colors.border.dark}>
            {UIStyles.border.doubleLine(actualWidth)}
          </Text>
        )}
        <Box height={1}><Text></Text></Box>
      </Box>
    );
  };

  // 渲染底部
  const renderFooter = () => {
    const actualWidth = Math.min(terminalWidth, width);
    
    return (
      <Box flexDirection="column" marginTop={1} style={style}>
        <Box height={1}><Text></Text></Box>
        {border && (
          <Text color={borderColor || theme.colors.border.light}>
            {UIStyles.border.line(actualWidth)}
          </Text>
        )}
        {title && (
          <Box justifyContent="center" paddingX={padding} paddingY={1}>
            <Text color={theme.colors.muted}>
              {centerText(title, actualWidth - padding * 2)}
            </Text>
          </Box>
        )}
        {border && (
          <Text color={borderColor || theme.colors.border.light}>
            {UIStyles.border.line(actualWidth)}
          </Text>
        )}
      </Box>
    );
  };

  // 渲染卡片
  const renderCard = () => {
    const actualWidth = Math.min(terminalWidth, width);
    const contentWidth = actualWidth - 2 - padding * 2;
    
    return (
      <Box
        borderStyle="round"
        borderColor={borderColor || theme.colors.border.light}
        backgroundColor={backgroundColor || theme.colors.background.primary}
        padding={padding}
        margin={margin}
        style={style}
      >
        <Box flexDirection="column">
          {title && (
            <Box marginBottom={1}>
              <Text color={theme.colors.primary} bold>
                {alignText(title, contentWidth, align)}
              </Text>
            </Box>
          )}
          <Box>{children}</Box>
        </Box>
      </Box>
    );
  };

  // 渲染分隔线
  const renderDivider = () => {
    const actualWidth = Math.min(terminalWidth, width);
    
    if (!title) {
      return (
        <Box marginY={1} style={style}>
          <Text color={borderColor || theme.colors.border.light}>
            {UIStyles.border.line(actualWidth)}
          </Text>
        </Box>
      );
    }

    const lineChar = borderColor === 'double' ? '═' : '─';
    const availableWidth = actualWidth - title.length - 2; // 2 for spaces around text

    if (availableWidth <= 0) {
      return (
        <Box marginY={1} style={style}>
          <Text color={theme.colors.info}>{title}</Text>
        </Box>
      );
    }

    const leftPadding = Math.floor(availableWidth / 2);
    const rightPadding = availableWidth - leftPadding;

    return (
      <Box marginY={1} style={style}>
        <Text color={borderColor || theme.colors.border.light}>
          {lineChar.repeat(leftPadding)}
        </Text>
        <Text color={theme.colors.info}> {title} </Text>
        <Text color={borderColor || theme.colors.border.light}>
          {lineChar.repeat(rightPadding)}
        </Text>
      </Box>
    );
  };

  // 渲染面板
  const renderPanel = () => {
    return (
      <Box
        borderStyle={border ? "round" : undefined}
        borderColor={borderColor || theme.colors.border.light}
        backgroundColor={backgroundColor || theme.colors.background.primary}
        padding={padding}
        margin={margin}
        style={style}
      >
        <Box flexDirection="column">
          {title && (
            <Box marginBottom={1}>
              <Text color={theme.colors.info}>{title}</Text>
            </Box>
          )}
          <Box>{children}</Box>
        </Box>
      </Box>
    );
  };

  return renderLayout();
};