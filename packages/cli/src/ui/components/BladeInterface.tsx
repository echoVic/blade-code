import { Box, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import { useSession } from '../../contexts/SessionContext.js';
import { useAppInitializer } from '../../hooks/useAppInitializer.js';
import { useCommandHandler } from '../../hooks/useCommandHandler.js';
import { useCommandHistory } from '../../hooks/useCommandHistory.js';
import { useKeyboardInput } from '../../hooks/useKeyboardInput.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { Header } from './Header.js';
import { InputArea } from './InputArea.js';
import { MessageArea } from './MessageArea.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';

interface BladeInterfaceProps {
  debug?: boolean;
  testMode?: boolean;
}

/**
 * Blade AI 主界面组件
 * 负责应用初始化、主界面渲染和所有业务逻辑的协调
 */
export const BladeInterface: React.FC<BladeInterfaceProps> = ({ 
  debug = false, 
  testMode = false 
}) => {
  const { state: sessionState, addUserMessage, addAssistantMessage } = useSession();
  
  const { isInitialized, loadingStatus, hasApiKey } = useAppInitializer(
    addAssistantMessage,
    debug
  );

  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(80);

  // 获取终端宽度
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

  // 使用 hooks
  const { isProcessing, executeCommand } = useCommandHandler();
  const {
    getPreviousCommand,
    getNextCommand,
    addToHistory,
  } = useCommandHistory();

  const { input } = useKeyboardInput(
    (command: string) => executeCommand(command, addUserMessage, addAssistantMessage),
    getPreviousCommand,
    getNextCommand,
    addToHistory
  );

  // 主界面 - 统一显示，不再区分初始化状态
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header testMode={testMode} />
      
      <MessageArea
        sessionState={sessionState}
        terminalWidth={terminalWidth}
        isProcessing={isProcessing}
        isInitialized={hasApiKey}
      />

      <InputArea 
        input={input} 
        isProcessing={isProcessing || !isInitialized} 
      />

      <ChatStatusBar
        messageCount={sessionState.messages.length}
        hasApiKey={hasApiKey}
        isProcessing={isProcessing || !isInitialized}
      />
      
      {/* 性能监控 - Debug 模式 */}
      {debug && (
        <Box position="absolute" width={30}>
          <PerformanceMonitor />
        </Box>
      )}
    </Box>
  );
};