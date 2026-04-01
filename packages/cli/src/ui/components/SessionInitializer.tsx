import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useRef } from 'react';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeExit } from '../../services/GracefulShutdown.js';
import { SessionService } from '../../services/SessionService.js';
import {
  useAppActions,
  useInitializationError,
  useInitializationStatus,
  usePermissionMode,
  useSessionActions,
} from '../../store/selectors/index.js';
import { configActions, getMessages } from '../../store/vanilla.js';
import type { PendingCommand } from '../../store/types.js';
import { themeManager } from '../themes/ThemeManager.js';
import { useThemeName } from '../../store/selectors/index.js';

const logger = createLogger(LogCategory.UI);

interface SessionInitializerProps {
  debug?: string;
  continueSession?: boolean;
  resume?: string;
  initialMessage?: string;
  permissionMode?: string;
  readyForChat: boolean;
  requiresSetup: boolean;
  executeCommand: (command: PendingCommand) => Promise<void>;
  addToHistory: (command: string) => void;
}

export const SessionInitializer: React.FC<SessionInitializerProps> = ({
  debug,
  continueSession,
  resume,
  initialMessage,
  permissionMode: cliPermissionMode,
  readyForChat,
  requiresSetup,
  executeCommand,
  addToHistory,
}) => {
  const hasProcessedResumeRef = useRef(false);
  const hasSentInitialMessage = useRef(false);
  const readyAnnouncementSent = useRef(false);
  const lastInitializationError = useRef<string | null>(null);

  const initializationError = useInitializationError();
  const initializationStatus = useInitializationStatus();
  const appActions = useAppActions();
  const sessionActions = useSessionActions();
  const permissionMode = usePermissionMode();
  const themeName = useThemeName();

  useEffect(() => {
    if (themeManager.getCurrentThemeName() !== themeName) {
      try {
        themeManager.setTheme(themeName);
      } catch {
        // 主题不存在，保持当前主题
      }
    }
  }, [themeName]);

  const handleContinue = useMemoizedFn(async () => {
    readyAnnouncementSent.current = true;
    try {
      const sessions = await SessionService.listSessions();

      if (sessions.length === 0) {
        sessionActions.addAssistantMessage('没有找到历史会话，开始新对话。');
        return;
      }

      const mostRecentSession = sessions[0];
      const messages = await SessionService.loadSession(mostRecentSession.sessionId);

      const sessionMessages = messages.map((msg, index) => ({
        id: `restored-${Date.now()}-${index}`,
        role: msg.role,
        content:
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: Date.now() - (messages.length - index) * 1000,
        metadata:
          msg.metadata && typeof msg.metadata === 'object'
            ? (msg.metadata as Record<string, unknown>)
            : undefined,
      }));

      sessionActions.restoreSession(mostRecentSession.sessionId, sessionMessages);
    } catch (error) {
      logger.error('[BladeInterface] 继续会话失败:', error);
      sessionActions.addAssistantMessage('继续会话失败，开始新对话。');
    }
  });

  const handleResume = useMemoizedFn(async () => {
    readyAnnouncementSent.current = true;
    try {
      if (typeof resume === 'string' && resume !== 'true') {
        const messages = await SessionService.loadSession(resume);

        const sessionMessages = messages.map((msg, index) => ({
          id: `restored-${Date.now()}-${index}`,
          role: msg.role,
          content:
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          timestamp: Date.now() - (messages.length - index) * 1000,
          metadata:
            msg.metadata && typeof msg.metadata === 'object'
              ? (msg.metadata as Record<string, unknown>)
              : undefined,
        }));

        sessionActions.restoreSession(resume, sessionMessages);
        return;
      }

      const sessions = await SessionService.listSessions();

      if (sessions.length === 0) {
        logger.error('没有找到历史会话');
        safeExit(1);
      }

      appActions.showSessionSelector(sessions);
    } catch (error) {
      logger.error('[BladeInterface] 加载会话失败:', error);
      safeExit(1);
    }
  });

  useEffect(() => {
    if (hasProcessedResumeRef.current) return;

    if (continueSession) {
      hasProcessedResumeRef.current = true;
      handleContinue();
      return;
    }

    if (resume) {
      hasProcessedResumeRef.current = true;
      handleResume();
    }
  }, [continueSession, resume, handleContinue, handleResume]);

  useEffect(() => {
    if (!readyForChat || readyAnnouncementSent.current) {
      return;
    }

    const messages = getMessages();
    if (messages.length > 0) {
      readyAnnouncementSent.current = true;
      return;
    }

    readyAnnouncementSent.current = true;
    sessionActions.addAssistantMessage('请输入您的问题，我将为您提供帮助。');
  }, [readyForChat]);

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

  const sendInitialMessage = useMemoizedFn(async (message: string) => {
    try {
      await executeCommand({
        displayText: message,
        text: message,
        images: [],
        parts: [{ type: 'text', text: message }],
      });
    } catch (error) {
      const fallback = error instanceof Error ? error.message : '无法发送初始消息';
      sessionActions.addAssistantMessage(`❌ 初始消息发送失败：${fallback}`);
    }
  });

  useEffect(() => {
    const message = initialMessage?.trim();
    if (!message || hasSentInitialMessage.current || !readyForChat || requiresSetup) {
      return;
    }

    hasSentInitialMessage.current = true;
    addToHistory(message);
    sendInitialMessage(message);
  }, [
    initialMessage,
    readyForChat,
    requiresSetup,
    executeCommand,
    addToHistory,
  ]);

  const applyPermissionMode = useMemoizedFn(async (mode: PermissionMode) => {
    try {
      await configActions().setPermissionMode(mode);
    } catch (error) {
      logger.error(
        '❌ 权限模式初始化失败:',
        error instanceof Error ? error.message : error
      );
    }
  });

  useEffect(() => {
    const targetMode = cliPermissionMode as PermissionMode | undefined;
    if (debug) {
      logger.debug('[Debug] permissionMode from CLI:', targetMode);
      logger.debug('[Debug] current permissionMode:', permissionMode);
    }
    if (!targetMode || targetMode === permissionMode) {
      return;
    }
    applyPermissionMode(targetMode);
  }, [cliPermissionMode, permissionMode]);

  return null;
};
