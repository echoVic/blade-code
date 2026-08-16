/**
 * LoadingIndicator 组件
 * 显示加载状态、幽默短语、计时器和循环进度
 *
 * 状态管理：
 * - 使用 Zustand selectors 内部获取状态，消除 Props Drilling
 */

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import {
  useActionStationarity,
  useIsProcessing,
  useIsReady,
  useProviderAdmission,
  useProviderCircuit,
  useProviderRetry,
  useProviderStall,
  useTheme,
} from '../../store/selectors/index.js';
import { useLoadingIndicator } from '../hooks/useLoadingIndicator.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';

interface LoadingIndicatorProps {
  message?: string; // 自定义消息（中性/真实动作文案优先）
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
    const providerAdmission = useProviderAdmission();
    const providerCircuit = useProviderCircuit();
    const providerRetry = useProviderRetry();
    const providerStall = useProviderStall();
    const actionStationarity = useActionStationarity();
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

    // 动画效果：每 150ms 切换一帧（降低频率减少 React 重渲染）
    // 当 paused=true 时暂停动画，避免被遮挡时仍触发重渲染
    useEffect(() => {
      if (!visible || paused) {
        setSpinnerFrame(0);
        return;
      }

      const timer = setInterval(() => {
        setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
      }, 150);

      return () => clearInterval(timer);
    }, [visible, paused]);

    if (!visible) {
      return null;
    }

    // 显示优先级：message（中性/真实动作）> currentPhrase（趣味短语）
    const retryMessage =
      providerRetry?.mode === 'bounded_foreground'
        ? `Provider 暂时不可用，正在有界恢复 (${providerRetry.attempt}/${providerRetry.maxRetries})，剩余约 ${formatElapsedTime(
            Math.max(0, Math.ceil((providerRetry.recoveryRemainingMs ?? 0) / 1_000))
          )}`
        : providerRetry?.phase === 'scheduled'
          ? `Provider 暂时不可用，${providerRetry.attempt}/${providerRetry.maxRetries} 次重试将在 ${Math.max(0, Math.ceil((providerRetry.delayMs ?? 0) / 1000))}s 后开始`
          : providerRetry?.phase === 'attempt'
            ? `正在重试 Provider (${providerRetry.attempt}/${providerRetry.maxRetries})`
            : null;
    const circuitMessage = providerCircuit
      ? providerCircuit.phase === 'probe'
        ? 'Provider 正在执行唯一恢复探测'
        : `Provider 故障已隔离，等待恢复探测${
            providerCircuit.retryAfterMs !== undefined
              ? ` (${formatElapsedTime(
                  Math.max(0, Math.ceil(providerCircuit.retryAfterMs / 1_000))
                )})`
              : ''
          }${
            providerCircuit.recoveryRemainingMs !== undefined
              ? `，剩余预算 ${formatElapsedTime(
                  Math.max(0, Math.ceil(providerCircuit.recoveryRemainingMs / 1_000))
                )}`
              : ''
          }`
      : null;
    const admissionMessage = providerAdmission
      ? `等待 Provider 容量（${providerAdmission.scope}，队列 ${providerAdmission.queuePosition}/${Math.max(
          providerAdmission.queueDepth,
          providerAdmission.queuePosition
        )}，已等待 ${formatElapsedTime(
          Math.max(0, Math.ceil(providerAdmission.waitMs / 1_000))
        )}）`
      : null;
    const stallMessage = providerStall
      ? providerStall.outputStarted
        ? `Provider 流已暂停 ${Math.ceil(providerStall.durationMs / 1000)}s，仍在等待（空闲超时上限 ${Math.ceil(providerStall.timeoutMs / 1000)}s）`
        : `Provider 尚未返回流数据，已等待 ${Math.ceil(providerStall.durationMs / 1000)}s（空闲超时上限 ${Math.ceil(providerStall.timeoutMs / 1000)}s）`
      : null;
    const stationarityMessage =
      actionStationarity?.phase === 'detected'
        ? `检测到 ${actionStationarity.toolName} 连续 ${actionStationarity.runLength} 次无进展，正在要求 Agent 切换策略`
        : actionStationarity?.phase === 'halted'
          ? `已停止 ${actionStationarity.toolName} 空转循环`
          : null;
    const displayMessage =
      stationarityMessage ||
      circuitMessage ||
      admissionMessage ||
      retryMessage ||
      stallMessage ||
      message ||
      currentPhrase ||
      '正在思考中...';

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
