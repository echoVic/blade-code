import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface LoadingIndicatorProps {
  visible: boolean;
  message?: string;
  loopState?: {
    active: boolean;
    turn: number;
    maxTurns: number;
    currentTool?: string;
  };
}

/**
 * 加载动画帧
 * 使用 Braille 点字符创建平滑的旋转动画
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 加载指示器组件
 * 独立的加载动画，不影响输入框性能
 */
export const LoadingIndicator: React.FC<LoadingIndicatorProps> = React.memo(
  ({ visible, message = '正在思考中...', loopState }) => {
    const [spinnerFrame, setSpinnerFrame] = useState(0);

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

    return (
      <Box paddingX={2} paddingBottom={1} flexDirection="column">
        {loopState?.active ? (
          <>
            <Box flexDirection="row" gap={1}>
              <Text color="yellow" bold>
                {SPINNER_FRAMES[spinnerFrame]}
              </Text>
              <Text color="cyan" bold>
                🔄 回合 {loopState.turn}/{loopState.maxTurns} (
                {Math.round((loopState.turn / loopState.maxTurns) * 100)}%)
              </Text>
            </Box>
            {loopState.currentTool && (
              <Box marginLeft={2}>
                <Text color="green">🔧 正在执行: {loopState.currentTool}</Text>
              </Box>
            )}
          </>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text color="yellow" bold>
              {SPINNER_FRAMES[spinnerFrame]}
            </Text>
            <Text color="yellow">{message}</Text>
          </Box>
        )}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    // 精确比较，只在必要时重渲染
    return (
      prevProps.visible === nextProps.visible &&
      prevProps.message === nextProps.message &&
      prevProps.loopState?.active === nextProps.loopState?.active &&
      prevProps.loopState?.turn === nextProps.loopState?.turn &&
      prevProps.loopState?.currentTool === nextProps.loopState?.currentTool
    );
  }
);
