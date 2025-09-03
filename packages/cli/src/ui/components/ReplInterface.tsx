import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { useSession } from '../contexts/SessionContext.js';

interface ReplInterfaceProps {
  onCommandSubmit: (command: string) => Promise<void>;
}

export const ReplInterface: React.FC<ReplInterfaceProps> = ({ onCommandSubmit }) => {
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const { state: sessionState } = useSession();
  const { exit } = useApp();

  const handleSubmit = useCallback(async () => {
    if (input.trim() && !isProcessing) {
      setIsProcessing(true);
      try {
        await onCommandSubmit(input.trim());
        setInput('');
      } catch (error) {
        console.error('命令执行失败:', error);
      } finally {
        setIsProcessing(false);
      }
    }
  }, [input, isProcessing, onCommandSubmit]);

  // 处理用户输入
  useInput((inputKey, key) => {
    if (key.return) {
      // 回车键提交命令
      handleSubmit();
    } else if (key.ctrl && key.name === 'c') {
      // Ctrl+C 退出
      exit();
    } else if (key.backspace || key.delete) {
      // 退格键删除字符
      setInput(prev => prev.slice(0, -1));
    } else if (inputKey && key.name !== 'escape') {
      // 普通字符输入
      setInput(prev => prev + inputKey);
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      {/* 消息显示区域 */}
      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {sessionState.messages.map((message) => (
          <Box key={message.id} marginBottom={1}>
            <Text color={message.role === 'user' ? 'green' : 'blue'}>
              {message.role === 'user' ? '> ' : '🤖 '}
            </Text>
            <Text>{message.content}</Text>
          </Box>
        ))}
        
        {isProcessing && (
          <Box>
            <Text color="yellow">⏳ 思考中...</Text>
          </Box>
        )}
        
        {sessionState.error && (
          <Box>
            <Text color="red">❌ {sessionState.error}</Text>
          </Box>
        )}
      </Box>

      {/* 输入区域 */}
      <Box flexDirection="row" alignItems="center">
        <Text color="green">{'>'} </Text>
        <Text>{input}</Text>
        {isProcessing && <Text color="yellow">|</Text>}
      </Box>

      {/* 帮助提示 */}
      <Box marginTop={1}>
        <Text color="gray">
          输入命令后按回车执行，Ctrl+C 退出，/help 查看帮助
        </Text>
      </Box>
    </Box>
  );
};