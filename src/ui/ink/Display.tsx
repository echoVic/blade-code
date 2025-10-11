/**
 * Ink Display 组件 - 现代化终端显示组件
 */
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';
import { UIStyles } from '../themes/styles.js';
import { themeManager } from '../themes/theme-manager.js';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface DisplayOptions {
  prefix?: string;
  suffix?: string;
  newline?: boolean;
  indent?: number;
}

interface DisplayProps {
  type?:
    | 'text'
    | 'success'
    | 'error'
    | 'warning'
    | 'info'
    | 'header'
    | 'section'
    | 'code'
    | 'quote'
    | 'separator'
    | 'highlight'
    | 'step'
    | 'spinner';
  content: string;
  options?: DisplayOptions;
  language?: string;
  author?: string;
  stepInfo?: { current: number; total: number };
  spinnerType?: string;
  spinnerLabel?: string;
  style?: React.CSSProperties;
}

export const Display: React.FC<DisplayProps> = ({
  type = 'text',
  content,
  options = {},
  language,
  author,
  stepInfo,
  spinnerType = 'dots',
  spinnerLabel = '',
  style,
}) => {
  const [theme, setTheme] = useState(() => themeManager.getTheme());

  // 监听主题变化
  useEffect(() => {
    const handleThemeChange = () => {
      setTheme(themeManager.getTheme());
    };

    // 这里可以添加主题变化的监听机制
    // 目前是简化的实现
    handleThemeChange();
  }, []);

  // 格式化文本
  const formatText = (text: string, opts: DisplayOptions = {}): string => {
    const defaultOptions: DisplayOptions = {
      newline: true,
      indent: 0,
    };

    const mergedOpts = { ...defaultOptions, ...options, ...opts };

    let result = text;

    // 添加前缀
    if (mergedOpts.prefix) {
      result = mergedOpts.prefix + result;
    }

    // 添加后缀
    if (mergedOpts.suffix) {
      result = result + mergedOpts.suffix;
    }

    // 添加缩进
    if (mergedOpts.indent && mergedOpts.indent > 0) {
      const indent = ' '.repeat(mergedOpts.indent);
      result = indent + result.split('\n').join('\n' + indent);
    }

    return result;
  };

  // 渲染不同类型的内容
  const renderContent = () => {
    switch (type) {
      case 'success':
        return (
          <Text color={theme.colors.success}>
            {UIStyles.icon.success} {formatText(content, options)}
          </Text>
        );

      case 'error':
        return (
          <Text color={theme.colors.error}>
            {UIStyles.icon.error} {formatText(content, options)}
          </Text>
        );

      case 'warning':
        return (
          <Text color={theme.colors.warning}>
            {UIStyles.icon.warning} {formatText(content, options)}
          </Text>
        );

      case 'info':
        return (
          <Text color={theme.colors.info}>
            {UIStyles.icon.info} {formatText(content, options)}
          </Text>
        );

      case 'header':
        return (
          <Text color={theme.colors.primary} bold>
            {UIStyles.icon.rocket} {formatText(content, options)}
          </Text>
        );

      case 'section':
        return (
          <Box flexDirection="column">
            <Text color={theme.colors.info}>{formatText(content, options)}</Text>
          </Box>
        );

      case 'code': {
        const prefix = language ? (
          <Text color={theme.colors.muted}>[{language}]</Text>
        ) : null;
        return (
          <Box flexDirection="column">
            {prefix && <Box marginBottom={1}>{prefix}</Box>}
            <Text
              color={theme.colors.text.primary}
              backgroundColor={theme.colors.background.secondary}
            >
              {formatText(content, options)}
            </Text>
          </Box>
        );
      }

      case 'quote':
        return (
          <Box flexDirection="column">
            <Text color={theme.colors.text.secondary} italic>
              "{formatText(content, options)}"
            </Text>
            {author && (
              <Text color={theme.colors.muted} marginTop={1}>
                - {author}
              </Text>
            )}
          </Box>
        );

      case 'separator':
        return (
          <Text color={theme.colors.border.light}>
            {UIStyles.border.line(content ? parseInt(content) : 50)}
          </Text>
        );

      case 'highlight':
        return (
          <Text
            color={theme.colors.text.primary}
            backgroundColor={theme.colors.highlight}
          >
            {formatText(content, options)}
          </Text>
        );

      case 'step':
        if (!stepInfo) return <Text>{formatText(content, options)}</Text>;
        return (
          <Text>
            <Text color={theme.colors.info}>
              [{stepInfo.current}/{stepInfo.total}]
            </Text>{' '}
            {formatText(content, options)}
          </Text>
        );

      case 'spinner':
        return (
          <Text color="green">
            <Spinner type={spinnerType as any} /> {spinnerLabel}
          </Text>
        );

      default:
        return <Text>{formatText(content, options)}</Text>;
    }
  };

  return <Box style={style}>{renderContent()}</Box>;
};
