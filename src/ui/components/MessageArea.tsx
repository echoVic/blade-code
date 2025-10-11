import { Box, Text } from 'ink';
import React from 'react';
import { MessageRenderer } from './MessageRenderer.js';
import { getCopyright } from '../../utils/package-info.js';
import type { LoopState } from '../hooks/useCommandHandler.js';

interface MessageAreaProps {
  sessionState: any;
  terminalWidth: number;
  isProcessing: boolean;
  isInitialized: boolean;
  loopState: LoopState;
}

/**
 * 消息区域组件
 * 负责显示消息列表、欢迎界面和处理状态
 */
export const MessageArea: React.FC<MessageAreaProps> = ({
  sessionState,
  terminalWidth,
  isProcessing,
  isInitialized,
  loopState,
}) => {
  // 判断是否显示欢迎界面（只有assistant消息，没有用户消息）
  const hasUserMessages = sessionState.messages.some((msg: any) => msg.role === 'user');
  const showWelcome = !hasUserMessages;

  // Blade Logo - 紧凑左对齐版本
  const logo = [
    '██████╗ ██╗      █████╗ ██████╗ ███████╗',
    '██╔══██╗██║     ██╔══██╗██╔══██╗██╔════╝',
    '██████╔╝██║     ███████║██║  ██║█████╗  ',
    '██╔══██╗██║     ██╔══██║██║  ██║██╔══╝  ',
    '██████╔╝███████╗██║  ██║██████╔╝███████╗',
    '╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝',
  ];

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={2}
      paddingY={showWelcome ? 2 : 0}
    >
      <Box flexDirection="column" flexGrow={1}>
        {showWelcome ? (
          <Box flexDirection="column">
            {/* Logo 左对齐显示 */}
            <Box flexDirection="column" marginBottom={2}>
              {logo.map((line, index) => (
                <Text key={index} color="blue" bold>
                  {line}
                </Text>
              ))}
            </Box>

            {sessionState.messages.length === 0 ? (
              /* 无任何消息时的欢迎信息 - 左对齐 */
              <>
                {/* 使用提示 - 仿照 Gemini 的 Tips 风格 */}
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text color="gray" bold>
                      使用指南：
                    </Text>
                  </Box>
                  <Text color="gray">1. 输入问题、编辑文件或运行命令</Text>
                  <Text color="gray">2. 使用 /init 创建项目配置文件</Text>
                  <Text color="gray">3. 输入 /help 查看所有 slash 命令</Text>
                  <Text color="gray">4. 按 Ctrl+C 退出应用</Text>
                  {!isInitialized && (
                    <>
                      <Text></Text>
                      <Text color="yellow">
                        ⚠️ API 密钥未配置，请先设置环境变量 BLADE_API_KEY
                      </Text>
                    </>
                  )}
                </Box>

                {/* 品牌信息 - 左对齐 */}
                <Box flexDirection="column">
                  <Text color="cyan">智能代码助手命令行工具</Text>
                  <Text color="gray" dimColor>
                    {getCopyright()}
                  </Text>
                </Box>
              </>
            ) : (
              /* 有系统消息时显示消息内容 - 左对齐 */
              <>
                {sessionState.messages.map((msg: any, index: number) => (
                  <MessageRenderer
                    key={index}
                    content={msg.content}
                    role={msg.role}
                    terminalWidth={terminalWidth}
                  />
                ))}

                {/* 使用指南（简化版） - 左对齐 */}
                <Box flexDirection="column" marginTop={2}>
                  <Text color="gray">
输入问题开始对话 • 使用 /init 创建项目配置 • 输入 /help 查看 slash 命令
                  </Text>
                  <Box marginTop={1}>
                    <Text color="gray" dimColor>
                      {getCopyright()}
                    </Text>
                  </Box>
                </Box>
              </>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            {sessionState.messages.map((msg: any, index: number) => (
              <MessageRenderer
                key={index}
                content={msg.content}
                role={msg.role}
                terminalWidth={terminalWidth}
              />
            ))}
            {isProcessing && (
              <Box paddingX={2} flexDirection="column">
                {loopState.active ? (
                  <>
                    <Text color="cyan" bold>
                      🔄 回合 {loopState.turn}/{loopState.maxTurns} (
                      {Math.round((loopState.turn / loopState.maxTurns) * 100)}%)
                    </Text>
                    {loopState.currentTool && (
                      <Text color="green" bold>🔧 正在执行: {loopState.currentTool}</Text>
                    )}
                    <Text color="yellow">
                      按 ESC 停止任务
                    </Text>
                  </>
                ) : (
                  <Text color="yellow" bold>
                    正在思考中...
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};
