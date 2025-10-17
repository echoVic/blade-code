import { useMemoizedFn } from 'ahooks';
import { Box, useFocusManager, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import { PermissionMode } from '../../config/types.js';
import type { AppProps } from '../App.js';
import { useAppState, useTodos } from '../contexts/AppContext.js';
import { useSession } from '../contexts/SessionContext.js';
import { useAppInitializer } from '../hooks/useAppInitializer.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useConfirmation } from '../hooks/useConfirmation.js';
import { useKeyboardInput } from '../hooks/useKeyboardInput.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { ConfirmationPrompt } from './ConfirmationPrompt.js';
import { Header } from './Header.js';
import { InputArea } from './InputArea.js';
import { MessageArea } from './MessageArea.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { PermissionsManager } from './PermissionsManager.js';
import { SetupWizard } from './SetupWizard.js';
import { ThemeSelector } from './ThemeSelector.js';
import { TodoPanel } from './TodoPanel.js';

/**
 * BladeInterface 组件的 props 类型
 * 直接继承 AppProps，保持所有字段类型不变（包括 debug 的过滤器功能）
 */
export interface BladeInterfaceProps extends AppProps {}

/**
 * Blade Code 主界面组件
 * 负责应用初始化、主界面渲染和所有业务逻辑的协调
 */
export const BladeInterface: React.FC<BladeInterfaceProps> = ({
  debug,
  ...otherProps
}) => {
  // TODO: 实现 debug 过滤功能
  // 支持 --debug api,hooks 或 --debug "!statsig,!file" 等过滤模式
  // debug 字段类型为 string | undefined，可以包含逗号分隔的类别列表
  // 正向过滤：只显示指定类别（如 "api,hooks"）
  // 负向过滤：排除指定类别（如 "!statsig,!file"）

  // 调试输出：显示接收到的 props
  if (debug) {
    console.log('[Debug] BladeInterface props:', {
      permissionMode: otherProps.permissionMode,
      yolo: otherProps.yolo,
    });
  }

  const { state: appState, dispatch: appDispatch, actions: appActions } = useAppState();
  const { state: sessionState, addUserMessage, addAssistantMessage } = useSession();
  const { todos, showTodoPanel } = useTodos();

  const {
    status: initializationStatus,
    readyForChat,
    requiresSetup,
    errorMessage: initializationError,
    handleSetupComplete,
  } = useAppInitializer({ debug: Boolean(debug) });

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

  // 确认管理
  const { confirmationState, confirmationHandler, handleResponse } = useConfirmation();

  // 使用 hooks
  const { isProcessing, executeCommand, loopState, handleAbort } = useCommandHandler(
    otherProps.systemPrompt,
    otherProps.appendSystemPrompt,
    confirmationHandler
  );
  const { getPreviousCommand, getNextCommand, addToHistory } = useCommandHistory();

  const hasSentInitialMessage = useRef(false);
  const readyAnnouncementSent = useRef(false);
  const lastInitializationError = useRef<string | null>(null);

  const handlePermissionModeToggle = useMemoizedFn(async () => {
    const configManager = ConfigManager.getInstance();
    const currentMode: PermissionMode = appState.permissionMode || PermissionMode.DEFAULT;

    // Shift+Tab 在 DEFAULT 和 AUTO_EDIT 之间切换
    const nextMode: PermissionMode =
      currentMode === PermissionMode.DEFAULT
        ? PermissionMode.AUTO_EDIT
        : PermissionMode.DEFAULT;

    try {
      await configManager.setPermissionMode(nextMode);
      appDispatch(appActions.setPermissionMode(nextMode));
    } catch (error) {
      // 只在失败时显示错误通知
      appDispatch(
        appActions.addNotification({
          type: 'error',
          title: '权限模式切换失败',
          message: error instanceof Error ? error.message : '未知错误',
        })
      );
    }
  });

  const { input, showSuggestions, suggestions, selectedSuggestionIndex } =
    useKeyboardInput(
      (command: string) => executeCommand(command, addUserMessage, addAssistantMessage),
      getPreviousCommand,
      getNextCommand,
      addToHistory,
      handleAbort,
      isProcessing,
      handlePermissionModeToggle
    );

  // 焦点管理：根据不同状态切换焦点
  const { focus } = useFocusManager();
  useEffect(() => {
    if (requiresSetup) {
      // SetupWizard 显示时，由 SetupWizard 自己管理焦点
      return;
    }

    if (confirmationState.isVisible) {
      // 显示确认对话框时，焦点转移到对话框
      focus('confirmation-prompt');
    } else {
      // 其他情况，焦点在主输入框
      focus('main-input');
    }
  }, [requiresSetup, confirmationState.isVisible, focus]);

  useEffect(() => {
    if (!readyForChat || readyAnnouncementSent.current) {
      return;
    }

    readyAnnouncementSent.current = true;
    addAssistantMessage('Blade Code 助手已就绪！');
    addAssistantMessage('请输入您的问题，我将为您提供帮助。');
  }, [readyForChat, addAssistantMessage]);

  useEffect(() => {
    if (!initializationError) {
      return;
    }

    if (lastInitializationError.current === initializationError) {
      return;
    }

    lastInitializationError.current = initializationError;

    if (initializationStatus === 'error') {
      addAssistantMessage(`❌ 初始化失败: ${initializationError}`);
    } else {
      addAssistantMessage(`❌ ${initializationError}`);
      addAssistantMessage('请重新尝试设置，或检查文件权限');
    }
  }, [initializationError, initializationStatus, addAssistantMessage]);

  useEffect(() => {
    const message = otherProps.initialMessage?.trim();
    if (!message || hasSentInitialMessage.current || !readyForChat || requiresSetup) {
      return;
    }

    hasSentInitialMessage.current = true;
    addToHistory(message);

    (async () => {
      try {
        await executeCommand(message, addUserMessage, addAssistantMessage);
      } catch (error) {
        const fallback =
          error instanceof Error ? error.message : '无法发送初始消息';
        addAssistantMessage(`❌ 初始消息发送失败：${fallback}`);
      }
    })();
  }, [
    otherProps.initialMessage,
    readyForChat,
    requiresSetup,
    executeCommand,
    addUserMessage,
    addAssistantMessage,
    addToHistory,
  ]);

  // 设置向导取消回调
  const handleSetupCancel = () => {
    addAssistantMessage('❌ 设置已取消');
    addAssistantMessage('Blade 需要 API 配置才能正常工作。');
    addAssistantMessage('您可以稍后运行 Blade 重新进入设置向导。');
    process.exit(0); // 退出程序
  };

  useEffect(() => {
    const targetMode = otherProps.permissionMode as PermissionMode | undefined;
    if (debug) {
      console.log('[Debug] permissionMode from CLI:', targetMode);
      console.log('[Debug] current appState.permissionMode:', appState.permissionMode);
    }
    if (!targetMode || targetMode === appState.permissionMode) {
      return;
    }

    (async () => {
      try {
        const configManager = ConfigManager.getInstance();
        await configManager.setPermissionMode(targetMode);
        appDispatch(appActions.setPermissionMode(targetMode));
      } catch (error) {
        appDispatch(
          appActions.addNotification({
            type: 'error',
            title: '权限模式初始化失败',
            message: error instanceof Error ? error.message : '未知错误',
          })
        );
      }
    })();
  }, [otherProps.permissionMode, appState.permissionMode, appDispatch, appActions]);

  // 如果显示设置向导，渲染 SetupWizard 组件
  if (requiresSetup) {
    return (
      <SetupWizard onComplete={handleSetupComplete} onCancel={handleSetupCancel} />
    );
  }

  // 主界面 - 统一显示，不再区分初始化状态
  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 确认对话框覆盖层 */}
      {confirmationState.isVisible && confirmationState.details ? (
        <ConfirmationPrompt
          details={confirmationState.details}
          onResponse={handleResponse}
        />
      ) : appState.showThemeSelector ? (
        <ThemeSelector />
      ) : appState.showPermissionsManager ? (
        <PermissionsManager
          onClose={() => appDispatch(appActions.hidePermissionsManager())}
        />
      ) : (
        <>
          <Header />

          {/* TODO 面板 - 显示在顶部 */}
          {showTodoPanel && (
            <TodoPanel todos={todos} visible={showTodoPanel} compact={false} />
          )}

          <MessageArea
            sessionState={sessionState}
            terminalWidth={terminalWidth}
            isProcessing={isProcessing}
            isInitialized={readyForChat}
            loopState={loopState}
          />

          <InputArea input={input} isProcessing={isProcessing || !readyForChat} />

          {/* 命令建议列表 - 显示在输入框下方 */}
          <CommandSuggestions
            suggestions={suggestions}
            selectedIndex={selectedSuggestionIndex}
            visible={showSuggestions}
          />

          <ChatStatusBar
            messageCount={sessionState.messages.length}
            hasApiKey={readyForChat}
            isProcessing={isProcessing || !readyForChat}
            permissionMode={appState.permissionMode}
          />

          {/* 性能监控 - Debug 模式 */}
          {debug && (
            <Box position="absolute" width={30}>
              <PerformanceMonitor />
            </Box>
          )}
        </>
      )}
    </Box>
  );
};
