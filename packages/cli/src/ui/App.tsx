import { useMemoizedFn } from 'ahooks';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';
import { ConfigService } from '../config/ConfigService.js';
import { SessionProvider, useSession } from '../contexts/SessionContext.js';
import { CommandOrchestrator, CommandResult } from '../services/CommandOrchestrator.js';
import { MessageRenderer } from './components/MessageRenderer.js';

interface AppProps {
  debug?: boolean;
  testMode?: boolean;
}

// Blade AI 界面组件
const BladeInterface: React.FC<{
  isInitialized: boolean;
  sessionState: any;
  addUserMessage: (message: string) => void;
  addAssistantMessage: (message: string) => void;
  debug: boolean;
  testMode: boolean;
  hasApiKey: boolean;
}> = ({
  isInitialized,
  sessionState,
  addUserMessage,
  addAssistantMessage,
  debug,
  testMode,
  hasApiKey,
}) => {
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { exit } = useApp();
  const { dispatch } = useSession();
  const { stdout } = useStdout();

  // 获取终端宽度
  const [terminalWidth, setTerminalWidth] = useState(80);

  useEffect(() => {
    const updateTerminalWidth = () => {
      setTerminalWidth(stdout.columns || 80);
    };

    updateTerminalWidth();
    stdout.on('resize', updateTerminalWidth);

    return () => {
      stdout.off('resize', updateTerminalWidth);
    };
  }, [stdout]);

  // 初始化命令协调器
  const [commandOrchestrator] = useState(() => {
    try {
      return CommandOrchestrator.getInstance();
    } catch (error) {
      console.error('Failed to initialize CommandOrchestrator:', error);
      return null;
    }
  });

  // 处理命令提交
  const handleCommandSubmit = useCallback(
    async (command: string): Promise<CommandResult> => {
      console.log('[DEBUG] handleCommandSubmit 被调用，命令:', command);

      if (!commandOrchestrator) {
        console.log('[ERROR] commandOrchestrator 不可用');
        return { success: false, error: 'Command orchestrator not available' };
      }

      try {
        console.log('[DEBUG] 添加用户消息到UI');
        addUserMessage(command);

        console.log('[DEBUG] 开始执行命令...');
        const result = await commandOrchestrator.executeCommand(command);

        console.log('[DEBUG] 命令执行结果:', result);

        if (result.success && result.output) {
          console.log('[DEBUG] 添加助手消息到UI');
          addAssistantMessage(result.output);
        } else if (!result.success && result.error) {
          console.log('[DEBUG] 命令执行失败:', result.error);
          addAssistantMessage(`❌ ${result.error}`);
        } else if (result.success && !result.output) {
          // 成功但没有输出内容的情况
          console.log('[DEBUG] 命令执行成功但无输出内容');
          addAssistantMessage('✅ 处理完成');
        } else {
          // 未知状态
          console.log('[DEBUG] 未知的执行结果状态:', result);
          addAssistantMessage('⚠️ 处理完成，但结果状态不明确');
        }

        return result;
      } catch (error) {
        console.log('[ERROR] handleCommandSubmit 异常:', error);
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        const errorResult = { success: false, error: errorMessage };
        addAssistantMessage(`❌ ${errorMessage}`);
        return errorResult;
      }
    },
    [commandOrchestrator, addUserMessage, addAssistantMessage]
  );

  // 处理提交
  const handleSubmit = useCallback(async () => {
    console.log('[DEBUG] handleSubmit 被调用，输入:', input, '处理中:', isProcessing);

    if (input.trim() && !isProcessing) {
      const command = input.trim();

      console.log('[DEBUG] 开始处理命令:', command);

      // 立即清空输入框
      setInput('');

      // 添加到历史记录
      setCommandHistory(prev => [...prev, command]);
      setHistoryIndex(-1);

      console.log('[DEBUG] 设置处理状态为 true');
      setIsProcessing(true);
      dispatch({ type: 'SET_THINKING', payload: true });

      try {
        console.log('[DEBUG] 开始执行 handleCommandSubmit...');
        const result = await handleCommandSubmit(command);

        console.log('[DEBUG] handleCommandSubmit 完成，结果:', result);

        if (!result.success && result.error) {
          console.log('[DEBUG] 设置错误状态:', result.error);
          dispatch({ type: 'SET_ERROR', payload: result.error });
        } else {
          console.log('[DEBUG] 命令执行成功');
        }
      } catch (error) {
        console.log('[ERROR] handleSubmit 异常:', error);
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        dispatch({ type: 'SET_ERROR', payload: `执行失败: ${errorMessage}` });
      } finally {
        console.log('[DEBUG] 设置处理状态为 false');
        setIsProcessing(false);
        dispatch({ type: 'SET_THINKING', payload: false });
      }
    } else {
      console.log('[DEBUG] 跳过提交 - 输入为空或正在处理中');
    }
  }, [input, isProcessing, handleCommandSubmit, dispatch]);

  // 处理清屏
  const handleClear = useCallback(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_ERROR', payload: null });
  }, [dispatch]);

  // 处理退出
  const handleExit = useCallback(() => {
    exit();
  }, [exit]);

  // 持续的输入监听
  useInput((inputKey, key) => {
    if (key.return) {
      // 回车键提交命令
      handleSubmit();
    } else if ((key.ctrl && inputKey === 'c') || (key.meta && inputKey === 'c')) {
      // Ctrl+C 退出
      handleExit();
    } else if ((key.ctrl && inputKey === 'd') || (key.meta && inputKey === 'd')) {
      // Ctrl+D 退出
      handleExit();
    } else if ((key.ctrl && inputKey === 'l') || (key.meta && inputKey === 'l')) {
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
      setInput(prev => prev.slice(0, -1));
    } else if (inputKey && inputKey !== '\u001b') {
      // 普通字符输入（排除 Escape 键）
      setInput(prev => prev + inputKey);
    }
  });

  // 判断是否显示欢迎界面（只有assistant消息，没有用户消息）
  const hasUserMessages = sessionState.messages.some((msg: any) => msg.role === 'user');
  const showWelcome = !hasUserMessages;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1} paddingX={2}>
        <Text color="cyan" bold>
          ⚡ Blade AI
        </Text>
        <Box flexDirection="row" gap={2}>
          {testMode && (
            <Text backgroundColor="red" color="white">
              {' '}
              TEST{' '}
            </Text>
          )}
          <Text color="gray" dimColor>
            Press Ctrl+C to exit
          </Text>
        </Box>
      </Box>

      {/* Main Content Area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle={showWelcome ? 'round' : undefined}
        paddingX={2}
        paddingY={showWelcome ? 1 : 0}
      >
        {/* Message Area */}
        <Box flexDirection="column" flexGrow={1}>
          {showWelcome ? (
            <Box flexDirection="column" gap={1}>
              {sessionState.messages.length === 0 ? (
                <>
                  <Text color="green">Welcome to Blade AI Assistant!</Text>
                  <Text color="gray">• Type your question to start chatting</Text>
                  <Text color="gray">• Press Ctrl+C to exit</Text>
                  {!isInitialized && (
                    <Text color="yellow">⚠️ 检测到尚未配置 API 密钥，请先配置后使用</Text>
                  )}
                </>
              ) : (
                <>
                  {sessionState.messages.map((msg: any, index: number) => (
                    <MessageRenderer
                      key={index}
                      content={msg.content}
                      role={msg.role}
                      terminalWidth={terminalWidth}
                    />
                  ))}
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
                <Box paddingX={2}>
                  <Text color="yellow" dimColor>
                    正在思考中...
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>

      {/* 交互式输入区域 */}
      <Box flexDirection="row" paddingX={2} paddingY={0} borderStyle="round" borderColor="gray">
        <Text color="blue" bold>
          {'> '}
        </Text>
        <Text>{input}</Text>
        {isProcessing ? (
          <Text color="yellow">█</Text>
        ) : (
          <Text color="white">█</Text>
        )}
      </Box>

      {/* 状态栏 */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
        <Box flexDirection="row" gap={2}>
          {sessionState.messages.length > 0 && (
            <Text color="gray" dimColor>
              {sessionState.messages.length} messages
            </Text>
          )}
        </Box>
        {!hasApiKey ? (
          <Text color="red">⚠ API 密钥未配置</Text>
        ) : isProcessing ? (
          <Text color="yellow">Processing...</Text>
        ) : (
          <Text color="green">Ready</Text>
        )}
      </Box>
    </Box>
  );
};

export const BladeApp: React.FC<AppProps> = ({ debug = false, testMode = false }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('正在初始化...');
  const [hasApiKey, setHasApiKey] = useState(false);

  const { state: sessionState, addUserMessage, addAssistantMessage } = useSession();

  // 初始化应用
  const initializeApp = useMemoizedFn(async () => {
    try {
      setLoadingStatus('加载配置...');

      // 初始化配置服务
      const configService = ConfigService.getInstance();
      await configService.initialize();
      const config = configService.getConfig();

      setLoadingStatus('检查 API 密钥...');

      // 检查 API 密钥配置
      if (!config.auth.apiKey || config.auth.apiKey.trim() === '') {
        setHasApiKey(false);
        setIsInitialized(true);
        addAssistantMessage('🚀 欢迎使用 Blade AI 助手！');
        addAssistantMessage('/help for help, /status for your current setup');
        addAssistantMessage(`Cwd: ${process.cwd()}`);
        addAssistantMessage(
          '⚠️  API Key 未配置\n\nAPI Base URL: https://apis.iflow.cn\n\n📋 配置步骤:\n1. 设置环境变量: export BLADE_API_KEY="your-api-key"\n2. 重新启动 Blade\n\n💡 或者使用命令行参数: blade --api-key="your-api-key"'
        );
        return;
      }

      setLoadingStatus('初始化完成!');
      setHasApiKey(true);
      setIsInitialized(true);

      addAssistantMessage('🚀 Blade AI 助手已就绪！');
      addAssistantMessage('请输入您的问题，我将为您提供帮助。');

      console.log('Blade 应用初始化完成');
    } catch (error) {
      console.error('应用初始化失败:', error);
      addAssistantMessage(`❌ 初始化失败: ${error}`);
      setIsInitialized(true);
    }
  });

  // 应用初始化
  useEffect(() => {
    if (!isInitialized) {
      initializeApp();
    }
  }, [isInitialized, initializeApp]);

  if (!isInitialized) {
    return (
      <Box flexDirection="column" justifyContent="center" alignItems="center">
        <Text color="cyan" bold>
          ⚡ Blade AI
        </Text>
        <Text color="yellow">⏳ {loadingStatus}</Text>
      </Box>
    );
  }

  return (
    <BladeInterface
      isInitialized={isInitialized}
      sessionState={sessionState}
      addUserMessage={addUserMessage}
      addAssistantMessage={addAssistantMessage}
      debug={debug}
      testMode={testMode}
      hasApiKey={hasApiKey}
    />
  );
};

// 包装器组件 - 提供会话上下文
export const AppWrapper: React.FC<AppProps> = props => {
  return (
    <SessionProvider>
      <BladeApp {...props} />
    </SessionProvider>
  );
};

export default AppWrapper;
