import { Box, Text, useApp, useInput } from 'ink';
import React, { useCallback, useState } from 'react';
import { CommandResult } from '../../services/CommandOrchestrator.js';
import { useSession } from '../contexts/SessionContext.js';

interface EnhancedReplInterfaceProps {
  onCommandSubmit: (command: string) => Promise<CommandResult>;
  onClear: () => void;
  onExit: () => void;
}

export const EnhancedReplInterface: React.FC<EnhancedReplInterfaceProps> = ({
  onCommandSubmit,
  onClear,
  onExit,
}) => {
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { state: sessionState, dispatch } = useSession();
  const { exit } = useApp();

  const handleSubmit = useCallback(async () => {
    if (input.trim() && !isProcessing) {
      const command = input.trim();

      // 添加到历史记录
      setCommandHistory((prev) => [...prev, command]);
      setHistoryIndex(-1);

      setIsProcessing(true);
      dispatch({ type: 'SET_THINKING', payload: true });

      try {
        const result = await onCommandSubmit(command);

        if (!result.success && result.error) {
          dispatch({ type: 'SET_ERROR', payload: result.error });
        }

        setInput('');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        dispatch({ type: 'SET_ERROR', payload: `执行失败: ${errorMessage}` });
      } finally {
        setIsProcessing(false);
        dispatch({ type: 'SET_THINKING', payload: false });
      }
    }
  }, [input, isProcessing, onCommandSubmit, dispatch]);

  const handleClear = useCallback(() => {
    onClear();
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_ERROR', payload: null });
  }, [onClear, dispatch]);

  const handleExit = useCallback(() => {
    onExit();
    exit();
  }, [onExit, exit]);

  // 处理用户输入
  useInput((inputKey, key) => {
    if (key.return) {
      // 回车键提交命令
      handleSubmit();
    } else if (key.ctrl && key.name === 'c') {
      // Ctrl+C 退出
      handleExit();
    } else if (key.ctrl && key.name === 'l') {
      // Ctrl+L 清屏
      handleClear();
    } else if (key.upArrow && commandHistory.length > 0) {
      // 上箭头 - 命令历史
      const newIndex =
        historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(commandHistory[newIndex] || '');
    } else if (key.downArrow) {
      // 下箭头 - 命令历史
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= commandHistory.length) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex] || '');
        }
      }
    } else if (key.backspace || key.delete) {
      // 退格键删除字符
      setInput((prev) => prev.slice(0, -1));
    } else if (inputKey && key.name !== 'escape') {
      // 普通字符输入
      setInput((prev) => prev + inputKey);
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Claude Code 风格标题栏 */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        borderStyle="round"
      >
        <Text color="cyan" bold>
          ⚡ Blade AI
        </Text>
        <Text color="gray" dimColor>
          Press Ctrl+C to exit
        </Text>
      </Box>

      {/* 主要内容区域 */}
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {/* 欢迎信息或消息历史 */}
        {sessionState.messages.length === 0 && !sessionState.error ? (
          <Box flexDirection="column" gap={1}>
            <Text color="green">Welcome to Blade AI Assistant!</Text>
            <Text color="gray">• Type your question to start chatting</Text>
            <Text color="gray">• Use /help to see available commands</Text>
            <Text color="gray">• Press Ctrl+L to clear the screen</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {sessionState.messages.map((message) => (
              <Box key={message.id} flexDirection="column" marginBottom={1}>
                {message.role === 'user' ? (
                  <Box flexDirection="row" gap={1}>
                    <Text color="blue" bold>
                      You:
                    </Text>
                    <Text>{message.content}</Text>
                  </Box>
                ) : (
                  <Box flexDirection="column" gap={1}>
                    <Text color="green" bold>
                      Assistant:
                    </Text>
                    <Box marginLeft={2}>
                      <Text>{message.content}</Text>
                    </Box>
                  </Box>
                )}
              </Box>
            ))}

            {isProcessing && (
              <Box flexDirection="row" gap={1}>
                <Text color="green" bold>
                  Assistant:
                </Text>
                <Text color="yellow">Thinking...</Text>
              </Box>
            )}

            {sessionState.error && (
              <Box flexDirection="row" gap={1}>
                <Text color="red" bold>
                  Error:
                </Text>
                <Text color="red">{sessionState.error}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Claude Code 风格输入区域 */}
      <Box
        flexDirection="row"
        paddingX={2}
        paddingY={1}
        borderStyle="round"
        borderColor="gray"
      >
        <Text color="blue" bold>
          {'> '}
        </Text>
        <Text>{input}</Text>
        {isProcessing && <Text color="yellow">█</Text>}
      </Box>

      {/* 简洁状态栏 */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
        <Text color="gray" dimColor>
          {sessionState.messages.length > 0 &&
            `${sessionState.messages.length} messages`}
        </Text>
        <Text color="gray" dimColor>
          {isProcessing ? 'Processing...' : 'Ready'}
        </Text>
      </Box>
    </Box>
  );
};
