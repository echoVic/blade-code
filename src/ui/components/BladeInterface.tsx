import { useMemoizedFn } from 'ahooks';
import { Box, useApp } from 'ink';
import React, { useEffect, useRef } from 'react';
import {
  type ModelConfig,
  PermissionMode,
  type SetupConfig,
} from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SessionService } from '../../services/SessionService.js';
import {
  useActiveModal,
  useAppActions,
  useFocusActions,
  useInitializationError,
  useInitializationStatus,
  useIsThinking,
  useModelEditorTarget,
  usePermissionMode,
  useSessionActions,
  useSessionSelectorData,
} from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { configActions } from '../../store/vanilla.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { AppProps } from '../App.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useConfirmation } from '../hooks/useConfirmation.js';
import { useInputBuffer } from '../hooks/useInputBuffer.js';
import { useMainInput } from '../hooks/useMainInput.js';
import { AgentCreationWizard } from './AgentCreationWizard.js';
import { AgentsManager } from './AgentsManager.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { ConfirmationPrompt } from './ConfirmationPrompt.js';
import { InputArea } from './InputArea.js';
import { LoadingIndicator } from './LoadingIndicator.js';
import { MessageArea } from './MessageArea.js';
import { ModelConfigWizard } from './ModelConfigWizard.js';
import { ModelSelector } from './ModelSelector.js';
import { PermissionsManager } from './PermissionsManager.js';
import { SessionSelector } from './SessionSelector.js';
import { ThemeSelector } from './ThemeSelector.js';

// 创建 BladeInterface 专用 Logger
const logger = createLogger(LogCategory.UI);

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
  if (debug) {
    logger.debug('[Debug] BladeInterface props:', {
      permissionMode: otherProps.permissionMode,
      yolo: otherProps.yolo,
      maxTurns: otherProps.maxTurns,
    });
  }

  // ==================== State & Refs ====================
  const hasProcessedResumeRef = useRef(false);
  const hasSentInitialMessage = useRef(false);
  const readyAnnouncementSent = useRef(false);
  const lastInitializationError = useRef<string | null>(null);

  // ==================== Context & Hooks ====================
  // App 状态和 actions（从 Zustand Store）
  const initializationStatus = useInitializationStatus();
  const initializationError = useInitializationError();
  const activeModal = useActiveModal();
  const sessionSelectorData = useSessionSelectorData();
  const modelEditorTarget = useModelEditorTarget();
  const appActions = useAppActions();

  // Session actions
  const sessionActions = useSessionActions();

  // Focus
  const focusActions = useFocusActions();

  // 权限模式
  const permissionMode = usePermissionMode();

  // 是否正在思考
  const isThinking = useIsThinking();

  const { exit } = useApp();

  // ==================== Custom Hooks ====================
  // 从 status 派生布尔值
  const readyForChat = initializationStatus === 'ready';
  const requiresSetup = initializationStatus === 'needsSetup';
  const isInitializing = initializationStatus === 'idle';

  const {
    confirmationState,
    confirmationHandler,
    handleResponse: handleResponseRaw,
  } = useConfirmation();

  const { executeCommand, handleAbort } = useCommandHandler(
    otherProps.systemPrompt,
    otherProps.appendSystemPrompt,
    confirmationHandler,
    otherProps.maxTurns
  );

  const { getPreviousCommand, getNextCommand, addToHistory } = useCommandHistory();

  // ==================== Input Buffer ====================
  // 使用 useInputBuffer 创建稳定的输入状态，避免 resize 时重建
  const inputBuffer = useInputBuffer('', 0);

  // ==================== Memoized Handlers ====================
  const handlePermissionModeToggle = useMemoizedFn(async () => {
    const currentMode: PermissionMode = permissionMode;

    // Shift+Tab 循环切换: DEFAULT → AUTO_EDIT → PLAN → DEFAULT
    let nextMode: PermissionMode;
    if (currentMode === PermissionMode.DEFAULT) {
      nextMode = PermissionMode.AUTO_EDIT;
    } else if (currentMode === PermissionMode.AUTO_EDIT) {
      nextMode = PermissionMode.PLAN;
    } else {
      nextMode = PermissionMode.DEFAULT;
    }

    try {
      // 使用 configActions 自动同步内存 + 持久化
      await configActions().setPermissionMode(nextMode);
    } catch (error) {
      logger.error(
        '❌ 权限模式切换失败:',
        error instanceof Error ? error.message : error
      );
    }
  });

  const handleSetupComplete = useMemoizedFn(async (newConfig: SetupConfig) => {
    try {
      // 使用 configActions 统一入口：自动同步内存 + 持久化
      await configActions().addModel({
        name: newConfig.name,
        provider: newConfig.provider,
        apiKey: newConfig.apiKey,
        baseUrl: newConfig.baseUrl,
        model: newConfig.model,
      });

      // 设置完成后，将状态改为 ready（因为 API Key 已经配置）
      appActions.setInitializationStatus('ready');
    } catch (error) {
      logger.error(
        '❌ 初始化配置保存失败:',
        error instanceof Error ? error.message : error
      );
      // 即使出错也继续，让用户可以进入主界面
      appActions.setInitializationStatus('ready');
    }
  });

  const handleToggleShortcuts = useMemoizedFn(() => {
    if (activeModal === 'shortcuts') {
      appActions.closeModal();
    } else {
      appActions.setActiveModal('shortcuts');
    }
  });

  const { showSuggestions, suggestions, selectedSuggestionIndex } = useMainInput(
    inputBuffer,
    executeCommand,
    getPreviousCommand,
    getNextCommand,
    addToHistory,
    handleAbort,
    isThinking,
    handlePermissionModeToggle,
    handleToggleShortcuts,
    activeModal === 'shortcuts'
  );

  // 当有输入内容时，自动关闭快捷键帮助
  useEffect(() => {
    if (inputBuffer.value && activeModal === 'shortcuts') {
      appActions.closeModal();
    }
  }, [inputBuffer.value, activeModal, appActions]);

  const handleResume = useMemoizedFn(async () => {
    try {
      // 情况 1: 直接提供了 sessionId (--resume <sessionId>)
      if (typeof otherProps.resume === 'string' && otherProps.resume !== 'true') {
        const messages = await SessionService.loadSession(otherProps.resume);

        const sessionMessages = messages
          // 不再过滤 tool 消息，让工具输出也能被渲染
          .map((msg, index) => ({
            id: `restored-${Date.now()}-${index}`,
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content:
              typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content),
            timestamp: Date.now() - (messages.length - index) * 1000,
          }));

        sessionActions.restoreSession(otherProps.resume, sessionMessages);
        return;
      }

      // 情况 2: 交互式选择 (--resume 无参数)
      const sessions = await SessionService.listSessions();

      if (sessions.length === 0) {
        logger.error('没有找到历史会话');
        process.exit(1);
      }

      // 显示会话选择器
      appActions.showSessionSelector(sessions);
    } catch (error) {
      logger.error('[BladeInterface] 加载会话失败:', error);
      process.exit(1);
    }
  });

  useEffect(() => {
    if (hasProcessedResumeRef.current) return;
    if (!otherProps.resume) return;

    hasProcessedResumeRef.current = true;
    handleResume();
  }, [otherProps.resume, handleResume]);

  // ==================== Memoized Methods ====================
  const handleResponse = useMemoizedFn(async (response: ConfirmationResponse) => {
    const confirmationType = confirmationState.details?.type;

    // EnterPlanMode approved: Switch to Plan mode
    if (confirmationType === 'enterPlanMode' && response.approved) {
      try {
        // 更新内存中的权限模式（运行时状态，不持久化）
        await configActions().setPermissionMode(PermissionMode.PLAN);
        logger.debug('[BladeInterface] Entered Plan mode');
      } catch (error) {
        logger.error('[BladeInterface] Failed to enter Plan mode:', error);
      }
    }

    // ExitPlanMode approved: Agent layer handles mode switch via configActions
    // Store is already updated automatically, no manual sync needed
    if (confirmationType === 'exitPlanMode' && response.approved) {
      logger.debug('[BladeInterface] ExitPlanMode approved, Store auto-synced');
    }

    handleResponseRaw(response);
  });

  const handleSetupCancel = useMemoizedFn(() => {
    sessionActions.addAssistantMessage('❌ 设置已取消');
    sessionActions.addAssistantMessage('Blade 需要 API 配置才能正常工作。');
    sessionActions.addAssistantMessage('您可以稍后运行 Blade 重新进入设置向导。');
    process.exit(0); // 退出程序
  });

  const closeModal = useMemoizedFn(() => {
    appActions.closeModal();
  });

  const handleSessionSelect = useMemoizedFn(async (sessionId: string) => {
    try {
      const messages = await SessionService.loadSession(sessionId);

      const sessionMessages = messages.map((msg, index) => ({
        id: `restored-${Date.now()}-${index}`,
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content:
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: Date.now() - (messages.length - index) * 1000,
      }));

      sessionActions.restoreSession(sessionId, sessionMessages);
      appActions.closeModal();
    } catch (error) {
      logger.error('[BladeInterface] Failed to restore session:', error);
      appActions.closeModal();
    }
  });

  const handleSessionCancel = useMemoizedFn(() => {
    if (otherProps.resume) {
      exit();
    } else {
      appActions.closeModal();
    }
  });

  const handleModelEditRequest = useMemoizedFn((model: ModelConfig) => {
    appActions.showModelEditWizard(model);
  });

  const handleModelAddComplete = useMemoizedFn((addedConfig: SetupConfig) => {
    sessionActions.addAssistantMessage(
      `✅ 已添加模型配置: ${addedConfig.name}，并已切换到该模型`
    );
    closeModal();
  });

  const handleModelEditComplete = useMemoizedFn((updatedConfig: SetupConfig) => {
    sessionActions.addAssistantMessage(`✅ 已更新模型配置: ${updatedConfig.name}`);
    closeModal();
  });

  // ==================== Effects ====================
  // 焦点管理：根据不同状态切换焦点
  useEffect(() => {
    if (requiresSetup) {
      // ModelConfigWizard (setup 模式) 显示时，焦点转移到向导
      focusActions.setFocus(FocusId.MODEL_CONFIG_WIZARD);
      return;
    }

    if (confirmationState.isVisible) {
      // 显示确认对话框时，焦点转移到对话框
      focusActions.setFocus(FocusId.CONFIRMATION_PROMPT);
    } else if (activeModal === 'sessionSelector') {
      // 显示会话选择器时，焦点转移到选择器
      focusActions.setFocus(FocusId.SESSION_SELECTOR);
    } else if (activeModal === 'themeSelector') {
      // 显示主题选择器时，焦点转移到选择器
      focusActions.setFocus(FocusId.THEME_SELECTOR);
    } else if (activeModal === 'modelSelector') {
      // 显示模型选择器时，焦点转移到选择器
      focusActions.setFocus(FocusId.MODEL_SELECTOR);
    } else if (activeModal === 'modelAddWizard' || activeModal === 'modelEditWizard') {
      // ModelConfigWizard (add/edit 模式) 显示时，焦点转移到向导
      focusActions.setFocus(FocusId.MODEL_CONFIG_WIZARD);
    } else if (activeModal === 'permissionsManager') {
      // 显示权限管理器时，焦点转移到管理器
      focusActions.setFocus(FocusId.PERMISSIONS_MANAGER);
    } else if (activeModal === 'agentsManager') {
      // 显示 agents 管理器时，焦点转移到管理器
      focusActions.setFocus(FocusId.AGENTS_MANAGER);
    } else if (activeModal === 'agentCreationWizard') {
      // 显示 agent 创建向导时，焦点转移到向导
      focusActions.setFocus(FocusId.AGENT_CREATION_WIZARD);
    } else if (activeModal === 'shortcuts') {
      // 显示快捷键帮助时，焦点保持在主输入框（帮助面板可以通过 ? 或 Esc 关闭）
      focusActions.setFocus(FocusId.MAIN_INPUT);
    } else {
      // 其他情况，焦点在主输入框
      focusActions.setFocus(FocusId.MAIN_INPUT);
    }
  }, [requiresSetup, confirmationState.isVisible, activeModal, focusActions.setFocus]);

  useEffect(() => {
    if (!readyForChat || readyAnnouncementSent.current) {
      return;
    }

    readyAnnouncementSent.current = true;
    sessionActions.addAssistantMessage('请输入您的问题，我将为您提供帮助。');
  }, [readyForChat, sessionActions.addAssistantMessage]);

  useEffect(() => {
    if (!initializationError) {
      return;
    }

    if (lastInitializationError.current === initializationError) {
      return;
    }

    lastInitializationError.current = initializationError;

    if (initializationStatus === 'error') {
      sessionActions.addAssistantMessage(`❌ 初始化失败: ${initializationError}`);
    } else {
      sessionActions.addAssistantMessage(`❌ ${initializationError}`);
      sessionActions.addAssistantMessage('请重新尝试设置，或检查文件权限');
    }
  }, [initializationError, initializationStatus, sessionActions.addAssistantMessage]);

  // Memoized function to send initial message via executeCommand
  const sendInitialMessage = useMemoizedFn(async (message: string) => {
    try {
      await executeCommand(message);
    } catch (error) {
      const fallback = error instanceof Error ? error.message : '无法发送初始消息';
      sessionActions.addAssistantMessage(`❌ 初始消息发送失败：${fallback}`);
    }
  });

  useEffect(() => {
    const message = otherProps.initialMessage?.trim();
    if (!message || hasSentInitialMessage.current || !readyForChat || requiresSetup) {
      return;
    }

    hasSentInitialMessage.current = true;
    addToHistory(message);
    sendInitialMessage(message);
  }, [
    otherProps.initialMessage,
    readyForChat,
    requiresSetup,
    executeCommand,
    addToHistory,
  ]);

  // Memoized function to apply permission mode changes from CLI
  const applyPermissionMode = useMemoizedFn(async (mode: PermissionMode) => {
    try {
      // 使用 configActions 自动同步内存 + 持久化
      await configActions().setPermissionMode(mode);
    } catch (error) {
      logger.error(
        '❌ 权限模式初始化失败:',
        error instanceof Error ? error.message : error
      );
    }
  });

  useEffect(() => {
    const targetMode = otherProps.permissionMode as PermissionMode | undefined;
    if (debug) {
      logger.debug('[Debug] permissionMode from CLI:', targetMode);
      logger.debug('[Debug] current permissionMode:', permissionMode);
    }
    if (!targetMode || targetMode === permissionMode) {
      return;
    }
    applyPermissionMode(targetMode);
  }, [otherProps.permissionMode, permissionMode]);

  // 初始化中 - 不渲染任何内容，避免闪烁
  if (isInitializing) {
    return null;
  }

  // 如果显示设置向导，渲染 ModelConfigWizard 组件（setup 模式）
  if (requiresSetup) {
    return (
      <ModelConfigWizard
        mode="setup"
        onComplete={handleSetupComplete}
        onCancel={handleSetupCancel}
      />
    );
  }

  // 主界面 - 统一显示，不再区分初始化状态
  if (debug) {
    logger.debug('[Debug] 渲染主界面，条件检查:', {
      confirmationVisible: confirmationState.isVisible,
      activeModal: activeModal,
    });
  }

  const inlineModelSelectorVisible = activeModal === 'modelSelector';
  const editingModel = modelEditorTarget;
  const inlineModelWizardMode =
    activeModal === 'modelAddWizard'
      ? 'add'
      : activeModal === 'modelEditWizard' && editingModel
        ? 'edit'
        : null;
  const inlineModelUiVisible =
    inlineModelSelectorVisible || Boolean(inlineModelWizardMode);

  const agentsManagerVisible = activeModal === 'agentsManager';
  const agentCreationWizardVisible = activeModal === 'agentCreationWizard';

  const editingInitialConfig = editingModel
    ? {
        name: editingModel.name,
        provider: editingModel.provider,
        baseUrl: editingModel.baseUrl,
        apiKey: editingModel.apiKey,
        model: editingModel.model,
      }
    : undefined;

  const blockingModal =
    confirmationState.isVisible && confirmationState.details ? (
      <ConfirmationPrompt
        details={confirmationState.details}
        onResponse={handleResponse}
      />
    ) : activeModal === 'themeSelector' ? (
      <ThemeSelector />
    ) : activeModal === 'permissionsManager' ? (
      <PermissionsManager onClose={closeModal} />
    ) : activeModal === 'sessionSelector' ? (
      <SessionSelector
        sessions={sessionSelectorData}
        onSelect={handleSessionSelect}
        onCancel={handleSessionCancel}
      />
    ) : null;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {blockingModal ?? (
        <>
          {/* MessageArea 内部直接获取状态，不需要 props */}
          <MessageArea />

          {/* 加载指示器 - 内部计算可见性 */}
          <LoadingIndicator />

          <InputArea
            input={inputBuffer.value}
            cursorPosition={inputBuffer.cursorPosition}
            onChange={inputBuffer.setValue}
            onChangeCursorPosition={inputBuffer.setCursorPosition}
          />

          {inlineModelSelectorVisible && (
            <Box marginTop={1} paddingX={2}>
              <ModelSelector onClose={closeModal} onEdit={handleModelEditRequest} />
            </Box>
          )}

          {inlineModelWizardMode && (
            <Box marginTop={1} paddingX={2}>
              <ModelConfigWizard
                mode={inlineModelWizardMode}
                modelId={editingModel?.id}
                initialConfig={
                  inlineModelWizardMode === 'edit' ? editingInitialConfig : undefined
                }
                onComplete={
                  inlineModelWizardMode === 'edit'
                    ? handleModelEditComplete
                    : handleModelAddComplete
                }
                onCancel={closeModal}
              />
            </Box>
          )}

          {agentsManagerVisible && (
            <Box marginTop={1} paddingX={2}>
              <AgentsManager onComplete={closeModal} onCancel={closeModal} />
            </Box>
          )}

          {agentCreationWizardVisible && (
            <Box marginTop={1} paddingX={2}>
              <AgentCreationWizard onComplete={closeModal} onCancel={closeModal} />
            </Box>
          )}

          {/* 命令建议列表 - 显示在输入框下方 */}
          <CommandSuggestions
            suggestions={suggestions}
            selectedIndex={selectedSuggestionIndex}
            visible={showSuggestions && !inlineModelUiVisible}
          />
          {/* 状态栏 - 内部获取状态 */}
          <ChatStatusBar />
        </>
      )}
    </Box>
  );
};
