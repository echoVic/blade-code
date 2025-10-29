/**
 * LoadingIndicator 组件
 * 显示加载状态、幽默短语、计时器和循环进度
 */

import { Box, Text, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import { useLoadingIndicator } from '../hooks/useLoadingIndicator.js';
import { themeManager } from '../themes/ThemeManager.js';

interface LoadingIndicatorProps {
  visible: boolean;
  message?: string; // 自定义消息（向后兼容，优先级低于短语）
}

/**
 * 加载动画帧
 * 使用 Braille 点字符创建平滑的旋转动画
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 响应式断点（列）
 */
const RESPONSIVE_BREAKPOINT = 80;

/**
 * 格式化时间显示
 * @param seconds - 秒数
 * @returns 格式化的时间字符串（如：5s, 1m 23s）
 */
function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * 加载指示器组件
 * 独立的加载动画，显示幽默短语、计时器和循环进度
 */
export const LoadingIndicator: React.FC<LoadingIndicatorProps> = React.memo(
  ({ visible, message }) => {
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    const { stdout } = useStdout();
    const theme = themeManager.getTheme();

    // 获取终端宽度
    const terminalWidth = stdout.columns || 80;
    const isWideScreen = terminalWidth >= RESPONSIVE_BREAKPOINT;

    // 使用新的 hook 获取短语和计时器
    const { currentPhrase, elapsedTime } = useLoadingIndicator(
      visible,
      false // isWaiting - 目前不需要等待确认状态
    );

    // 动画效果：每 80ms 切换一帧
    useEffect(() => {
      if (!visible) {
        setSpinnerFrame(0);
        return;
      }

      const timer = setInterval(() => {
        setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
      }, 80);

      return () => clearInterval(timer);
    }, [visible]);

    if (!visible) {
      return null;
    }

    // 显示优先级：currentPhrase（幽默短语）> message（自定义消息）
    const displayMessage = currentPhrase || message || '正在思考中...';

    // 统一显示：短语 + 计时器 + 取消提示
    if (isWideScreen) {
      // 宽屏：单行显示
      return (
        <Box paddingX={2} paddingBottom={1} flexDirection="row" gap={1}>
          <Text color={theme.colors.warning} bold>
            {SPINNER_FRAMES[spinnerFrame]}
          </Text>
          <Text color={theme.colors.text.primary}>{displayMessage}</Text>
          {elapsedTime > 0 && (
            <>
              <Text color={theme.colors.muted}>|</Text>
              <Text color={theme.colors.info}>
                已用时: {formatElapsedTime(elapsedTime)}
              </Text>
            </>
          )}
          <Text color={theme.colors.muted}>|</Text>
          <Text color={theme.colors.secondary}>Esc 取消</Text>
        </Box>
      );
    }

    // 窄屏：多行显示
    return (
      <Box paddingX={2} paddingBottom={1} flexDirection="column">
        {/* 第一行：spinner + 短语 */}
        <Box flexDirection="row" gap={1}>
          <Text color={theme.colors.warning} bold>
            {SPINNER_FRAMES[spinnerFrame]}
          </Text>
          <Text color={theme.colors.text.primary}>{displayMessage}</Text>
        </Box>

        {/* 第二行：计时器 + 取消提示 */}
        {elapsedTime > 0 && (
          <Box marginLeft={2} flexDirection="row" gap={1}>
            <Text color={theme.colors.info}>
              已用时: {formatElapsedTime(elapsedTime)}
            </Text>
            <Text color={theme.colors.muted}>|</Text>
            <Text color={theme.colors.secondary}>Esc 取消</Text>
          </Box>
        )}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    // 精确比较，只在必要时重渲染
    return (
      prevProps.visible === nextProps.visible &&
      prevProps.message === nextProps.message
    );
  }
);
