import React from 'react';
import { Box, Text } from 'ink';
import type { AppView } from '../hooks/useAppNavigation.js';
import type { PerformanceStats } from '../contexts/AppContext.js';

interface StatusBarProps {
  currentView: AppView;
  performanceStats?: Partial<PerformanceStats>;
  className?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({ 
  currentView,
  performanceStats,
  className 
}) => {
  // 视图显示名称映射
  const viewNames: Record<AppView, string> = {
    main: '主界面',
    settings: '设置',
    help: '帮助',
    logs: '日志',
    tools: '工具',
    chat: '聊天',
    config: '配置',
  };

  // 获取当前时间
  const currentTime = new Date().toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

  // 内存使用率
  const memoryUsage = performanceStats?.memory?.percentage 
    ? `${performanceStats.memory.percentage.toFixed(1)}%` 
    : 'N/A';

  // FPS
  const fps = performanceStats?.render?.fps 
    ? `${performanceStats.render.fps} FPS` 
    : 'N/A';

  return (
    <Box 
      flexDirection="row" 
      justifyContent="space-between"
      alignItems="center"
      paddingX={1}
      paddingY={0}
      height={1}
      backgroundColor="#1F2937"
      {...(className ? { className } : {})}
    >
      {/* 左侧: 当前视图 */}
      <Box flexDirection="row" alignItems="center">
        <Text color="#93C5FD" bold>
          {viewNames[currentView]}
        </Text>
      </Box>

      {/* 中间: 性能指标 */}
      <Box flexDirection="row" alignItems="center">
        {performanceStats && (
          <>
            <Text color="#D1D5DB" dimColor>
              MEM: {memoryUsage}
            </Text>
            <Box marginLeft={2}>
              <Text color="#D1D5DB" dimColor>
                {fps}
              </Text>
            </Box>
          </>
        )}
      </Box>

      {/* 右侧: 时间 */}
      <Box flexDirection="row" alignItems="center">
        <Text color="#9CA3AF">
          {currentTime}
        </Text>
      </Box>
    </Box>
  );
};