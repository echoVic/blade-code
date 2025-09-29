import { Box, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import { useSession } from '../contexts/SessionContext.js';
import { useAppInitializer } from '../hooks/useAppInitializer.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useKeyboardInput } from '../hooks/useKeyboardInput.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { Header } from './Header.js';
import { InputArea } from './InputArea.js';
import { MessageArea } from './MessageArea.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';

interface BladeInterfaceProps {
  // 基础选项
  debug?: boolean;
  testMode?: boolean;
  verbose?: boolean;

  // 输出选项
  print?: boolean;
  outputFormat?: string;
  includePartialMessages?: boolean;
  inputFormat?: string;
  replayUserMessages?: boolean;

  // 权限和安全选项
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];

  // MCP 选项
  mcpDebug?: boolean;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;

  // 会话选项
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  sessionId?: string;

  // 模型选项
  model?: string;
  fallbackModel?: string;
  appendSystemPrompt?: string;
  agents?: string;

  // 文件系统选项
  settings?: string;
  addDir?: string[];
  settingSources?: string;

  // IDE 集成
  ide?: boolean;

  // 初始消息
  initialMessage?: string;
}

/**
 * Blade AI 主界面组件
 * 负责应用初始化、主界面渲染和所有业务逻辑的协调
 */
export const BladeInterface: React.FC<BladeInterfaceProps> = ({
  debug = false,
  testMode = false,
  ...otherProps
}) => {
  const { state: sessionState, addUserMessage, addAssistantMessage } = useSession();

  const { isInitialized, hasApiKey } = useAppInitializer(addAssistantMessage, debug);

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
  const { isProcessing, executeCommand } = useCommandHandler(otherProps.appendSystemPrompt);
  const { getPreviousCommand, getNextCommand, addToHistory } = useCommandHistory();

  const { input, showSuggestions, suggestions, selectedSuggestionIndex } = useKeyboardInput(
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

      {/* 命令建议列表 - 显示在输入框下方 */}
      <CommandSuggestions
        suggestions={suggestions}
        selectedIndex={selectedSuggestionIndex}
        visible={showSuggestions}
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
