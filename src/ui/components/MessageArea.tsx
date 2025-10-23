import { Box, Text } from 'ink';
import React from 'react';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import { getCopyright } from '../../utils/packageInfo.js';
import type { SessionState } from '../contexts/SessionContext.js';
import type { LoopState } from '../hooks/useCommandHandler.js';
import { MessageRenderer } from './MessageRenderer.js';
import { TodoPanel } from './TodoPanel.js';

interface MessageAreaProps {
  sessionState: SessionState;
  terminalWidth: number;
  isProcessing: boolean;
  isInitialized: boolean;
  loopState: LoopState;
  todos?: TodoItem[];
  showTodoPanel?: boolean;
}

/**
 * 消息区域组件
 * 负责显示消息列表、欢迎界面和处理状态
 */
export const MessageArea: React.FC<MessageAreaProps> = React.memo(({
  sessionState,
  terminalWidth,
  isProcessing,
  isInitialized,
  loopState,
  todos = [],
  showTodoPanel = false,
}) => {
  // 判断是否显示欢迎界面（只有assistant消息，没有用户消息）
  const hasUserMessages = sessionState.messages.some((msg) => msg.role === 'user');
  const showWelcome = !hasUserMessages;

  // 找到最后一条用户消息的索引（TodoPanel 将显示在这之后）
  const lastUserMessageIndex = sessionState.messages.findLastIndex(
    (msg) => msg.role === 'user'
  );

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
                    <Text color="white" bold>
                      使用指南：
                    </Text>
                  </Box>
                  <Text color="white">1. 输入问题、编辑文件或运行命令</Text>
                  <Text color="white">2. 使用 /init 创建项目配置文件</Text>
                  <Text color="white">3. 输入 /help 查看所有 slash 命令</Text>
                  <Text color="white">4. 按 Ctrl+C 退出应用</Text>
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
                {sessionState.messages.map((msg, index) => (
                  <MessageRenderer
                    key={index}
                    content={msg.content}
                    role={msg.role}
                    terminalWidth={terminalWidth}
                  />
                ))}

                {/* 使用指南（简化版） - 左对齐 */}
                <Box flexDirection="column" marginTop={2}>
                  <Text color="white">
                    输入问题开始对话 • 使用 /init 创建项目配置 • 输入 /help 查看 slash
                    命令
                  </Text>
                  <Box marginTop={1}>
                    <Text color="gray">{getCopyright()}</Text>
                  </Box>
                </Box>
              </>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            {sessionState.messages.map((msg: any, index: number) => (
              <React.Fragment key={index}>
                <MessageRenderer
                  content={msg.content}
                  role={msg.role}
                  terminalWidth={terminalWidth}
                />
                {/* 在最后一条用户消息后显示 TodoPanel */}
                {index === lastUserMessageIndex &&
                  showTodoPanel &&
                  todos.length > 0 && (
                    <TodoPanel todos={todos} visible={true} compact={false} />
                  )}
              </React.Fragment>
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
                      <Text color="green" bold>
                        🔧 正在执行: {loopState.currentTool}
                      </Text>
                    )}
                    <Text color="yellow">按 ESC 停止任务</Text>
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
});
