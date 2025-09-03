import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '../ui/ink/Spinner.js';

interface SplashScreenProps {
  progress?: number;
  status?: string;
  debug?: boolean;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ 
  progress = 0, 
  status = '正在启动...', 
  debug = false 
}) => {
  const logo = [
    "██████╗ ██╗      █████╗ ██████╗ ███████╗",
    "██╔══██╗██║     ██╔══██╗██╔══██╗██╔════╝",
    "██████╔╝██║     ███████║██║  ██║█████╗  ",
    "██╔══██╗██║     ██╔══██║██║  ██║██╔══╝  ",
    "██████╔╝███████╗██║  ██║██████╔╝███████╗",
    "╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝",
  ];

  return (
    <Box 
      flexDirection="column" 
      justifyContent="center" 
      alignItems="center"
      width="100%"
      height="100%"
      padding={2}
    >
      {/* Logo */}
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        {logo.map((line, index) => (
          <Text 
            key={index} 
            color="#4F46E5" 
            bold
          >
            {line}
          </Text>
        ))}
      </Box>

      {/* 版本和标语 */}
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        <Text color="#6B7280">
          AI驱动的智能命令行助手
        </Text>
        <Text color="#9CA3AF" dimColor>
          v1.2.8
        </Text>
      </Box>

      {/* 启动状态 */}
      <Box 
        flexDirection="column" 
        alignItems="center" 
        paddingX={4} 
        paddingY={1}
        borderStyle="round"
        borderColor="#4F46E5"
      >
        <Box flexDirection="row" alignItems="center">
          <Spinner type="clock" />
          <Text color="#6B7280" marginLeft={1}>
            {status}
          </Text>
        </Box>

        {/* 进度条 */}
        {progress > 0 && (
          <Box 
            flexDirection="row" 
            alignItems="center" 
            marginTop={1}
            width={30}
          >
            <Box 
              width={Math.floor((progress / 100) * 30)} 
              height={1}
              backgroundColor="#4F46E5"
            />
            <Box 
              width={Math.floor(((100 - progress) / 100) * 30)} 
              height={1}
              backgroundColor="#374151"
            />
          </Box>
        )}

        <Text color="#9CA3AF" dimColor marginTop={1}>
          {progress > 0 ? `${progress}%` : ''}
        </Text>
      </Box>

      {/* 调试信息 */}
      {debug && (
        <Box 
          flexDirection="column" 
          alignItems="center" 
          marginTop={2}
          paddingX={2}
          paddingY={1}
          borderStyle="round"
          borderColor="#F59E0B"
        >
          <Text color="#F59E0B" bold>
            🐛 调试模式已启用
          </Text>
          <Text color="#FBBF24" dimColor>
            启动参数: {process.argv.slice(2).join(' ')}
          </Text>
        </Box>
      )}

      {/* 版权信息 */}
      <Box 
        flexDirection="column" 
        alignItems="center" 
        position="absolute" 
        bottom={1} 
        width="100%"
      >
        <Text color="#6B7280" dimColor>
          © 2025 Blade AI - 为开发者而生的智能助手
        </Text>
      </Box>
    </Box>
  );
};