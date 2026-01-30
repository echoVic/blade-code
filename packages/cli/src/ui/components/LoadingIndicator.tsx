/**
 * LoadingIndicator 组件
 * 显示加载状态、幽默短语、计时器和循环进度
 *
 * 状态管理：
 * - 使用 Zustand selectors 内部获取状态，消除 Props Drilling
 */

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useIsProcessing, useIsReady, useTheme } from '../../store/selectors/index.js';
import { useLoadingIndicator } from '../hooks/useLoadingIndicator.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';

interface LoadingIndicatorProps {
  message?: string; // 自定义消息（向后兼容，优先级低于短语）
  /** 是否暂停动画（当被其他弹窗遮挡时，避免无意义的重渲染） */
  paused?: boolean;
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
  ({ message, paused = false }) => {
    // 使用 Zustand selectors 获取状态
    const isProcessing = useIsProcessing();
    const isReady = useIsReady();
    const visible = isProcessing || !isReady;

    const [spinnerFrame, setSpinnerFrame] = useState(0);
    const theme = useTheme();

    // 使用 useTerminalWidth hook 获取终端宽度
    const terminalWidth = useTerminalWidth();
    const isWideScreen = terminalWidth >= RESPONSIVE_BREAKPOINT;

    // 使用新的 hook 获取短语和计时器
    // 当 paused=true 时，hook 内部的定时器也会暂停
    const { currentPhrase, elapsedTime } = useLoadingIndicator(
      visible,
      false, // isWaiting - 目前不需要等待确认状态
      paused
    );

    // 动画效果：每 80ms 切换一帧
    // 当 paused=true 时暂停动画，避免被遮挡时仍触发重渲染
    useEffect(() => {
      if (!visible || paused) {
        setSpinnerFrame(0);
        return;
      }

      const timer = setInterval(() => {
        setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
      }, 80);

      return () => clearInterval(timer);
    }, [visible, paused]);

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
  }
);
