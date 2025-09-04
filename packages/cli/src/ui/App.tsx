import { useMemoizedFn } from 'ahooks';
import { Box, Text, useApp } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';
import { ConfigService } from '../config/ConfigService.js';
import { SessionProvider, useSession } from '../contexts/SessionContext.js';

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
}> = ({ isInitialized, sessionState, addUserMessage, addAssistantMessage, testMode, hasApiKey }) => {
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const { exit } = useApp();

  // 简化版本不处理交互式输入，只显示信息
  const handleSubmit = useCallback(async (_text: string) => {
    // 这里不处理任何输入
  }, []);

  // TODO: 在简化版本中，我们不处理实时输入
  // 用户可以直接在终端中按 Ctrl+C 退出
  useEffect(() => {
    const handleExit = () => {
      exit();
    };
    
    process.on('SIGINT', handleExit);
    return () => {
      process.off('SIGINT', handleExit);
    };
  }, [exit]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Main Content Area with Header and Messages */}
      <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={2} paddingY={1}>
        {/* Header */}
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color="cyan" bold>⚡ Blade AI</Text>
          <Box flexDirection="row" gap={2}>
            {testMode && <Text backgroundColor="red" color="white"> TEST </Text>}
            <Text color="gray" dimColor>Press Ctrl+C to exit</Text>
          </Box>
        </Box>
        
        {/* Message Area */}
        <Box flexDirection="column" flexGrow={1}>
          {sessionState.messages.length === 0 && !sessionState.error ? (
            <Box flexDirection="column" gap={1}>
              <Text color="green">Welcome to Blade AI Assistant!</Text>
              <Text color="gray">• Type your question to start chatting</Text>
              <Text color="gray">• Press Ctrl+C to exit</Text>
              {!isInitialized && (
                <Text color="yellow">⚠️  检测到尚未配置 API 密钥，请先配置后使用</Text>
              )}
            </Box>
          ) : (
            <Box flexDirection="column">
              {sessionState.messages.map((msg: any, index: number) => (
                <Box key={index} marginBottom={1}>
                  {msg.role === 'user' && (
                    <Box marginBottom={0}>
                      <Text color="cyan" bold>❯ User:</Text>
                    </Box>
                  )}
                  <Text color={msg.role === 'user' ? 'white' : 'green'}>
                    {msg.content}
                  </Text>
                </Box>
              ))}
              {isProcessing && (
                <Box>
                  <Text color="yellow" dimColor>正在思考中...</Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
      
      {/* Input Hint Area */}
      <Box flexDirection="row" paddingX={2} paddingY={0} borderStyle="round" borderColor="gray">
        <Text color="blue" bold>{'> '}</Text>
        <Text color="gray" dimColor>请在终端中直接输入...</Text>
      </Box>
      
      {/* Status Area */}
      <Box flexDirection="row" justifyContent="flex-end" paddingX={2} paddingTop={1}>
        {!hasApiKey && (
          <Text color="red">⚠ API 密钥未配置</Text>
        )}
      </Box>
    </Box>
  );
};

export const BladeApp: React.FC<AppProps> = ({ 
  debug = false, 
  testMode = false 
}) => {
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
        addAssistantMessage('API Base URL: https://apis.iflow.cn\n\n1. 配置密钥：export BLADE_API_KEY="your-api-key"\n2. 重新启动 Blade');
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
        <Text color="cyan" bold>⚡ Blade AI</Text>
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
export const AppWrapper: React.FC<AppProps> = (props) => {
  return (
    <SessionProvider>
      <BladeApp {...props} />
    </SessionProvider>
  );
};

export default AppWrapper;