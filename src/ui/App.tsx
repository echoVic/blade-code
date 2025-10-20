import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { GlobalOptions } from '../cli/types.js';
import { ConfigManager } from '../config/ConfigManager.js';
import type { Message } from '../services/ChatServiceInterface.js';
import { type SessionMetadata, SessionService } from '../services/SessionService.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { NotificationSystem } from './components/NotificationSystem.js';
import { SessionSelector } from './components/SessionSelector.js';
import { AppProvider } from './contexts/AppContext.js';
import {
  type SessionMessage,
  SessionProvider,
  useSession,
} from './contexts/SessionContext.js';
import { themeManager } from './themes/ThemeManager.js';

/**
 * UI 入口层的 props 类型
 * 继承所有 CLI 选项，并添加 UI 特有字段
 */
export interface AppProps extends GlobalOptions {
  // UI 特有字段
  initialMessage?: string; // 初始消息
  resume?: string; // 恢复会话：sessionId 或 true (交互式选择)
}

/**
 * 将 OpenAI Message 转换为 SessionMessage
 */
function convertToSessionMessages(messages: Message[]): SessionMessage[] {
  return messages
    .filter((msg) => {
      // 过滤掉 tool 角色消息（UI 不需要显示）
      return msg.role !== 'tool';
    })
    .map((msg, index) => {
      // 确保 content 是字符串
      let content: string;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else {
        content = JSON.stringify(msg.content);
      }

      return {
        id: `restored-${Date.now()}-${index}`,
        role: msg.role as 'user' | 'assistant' | 'system',
        content,
        timestamp: Date.now() - (messages.length - index) * 1000, // 估算时间戳
      };
    });
}

/**
 * Resume 处理组件 - 处理会话恢复逻辑
 */
const ResumeHandler: React.FC<AppProps> = (props) => {
  const { restoreSession } = useSession();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const hasLoadedRef = useRef(false); // 防止重复加载

  useEffect(() => {
    // 如果已经加载过,直接返回
    if (hasLoadedRef.current) {
      return;
    }
    hasLoadedRef.current = true;

    const handleResume = async () => {
      if (!props.resume) {
        setLoading(false);
        return;
      }

      try {
        // 情况 1: 直接提供了 sessionId
        if (typeof props.resume === 'string' && props.resume !== 'true') {
          const messages = await SessionService.loadSession(props.resume);
          const sessionMessages = convertToSessionMessages(messages);
          restoreSession(props.resume, sessionMessages);
          setResumed(true);
          setLoading(false);
          return;
        }

        // 情况 2: 交互式选择 (--resume 无参数)
        const availableSessions = await SessionService.listSessions();

        if (availableSessions.length === 0) {
          setError('没有找到历史会话');
          setLoading(false);
          return;
        }

        setSessions(availableSessions);
        setLoading(false);
      } catch (err) {
        console.error('[ResumeHandler] Error:', err);
        setError(err instanceof Error ? err.message : '加载会话失败');
        setLoading(false);
      }
    };

    handleResume();
  }, [props.resume]);

  const handleSelectSession = async (sessionId: string) => {
    try {
      setLoading(true);
      const messages = await SessionService.loadSession(sessionId);
      const sessionMessages = convertToSessionMessages(messages);
      restoreSession(sessionId, sessionMessages);
      setResumed(true);
      setLoading(false);
    } catch (err) {
      console.error('[ResumeHandler] Failed to load session:', err);
      setError(err instanceof Error ? err.message : '加载会话失败');
      setLoading(false);
    }
  };

  const handleCancel = () => {
    process.exit(0);
  };

  // 加载中
  if (loading) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text>⏳ 正在加载会话...</Text>
      </Box>
    );
  }

  // 错误状态
  if (error) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="red">❌ {error}</Text>
      </Box>
    );
  }

  // 显示会话选择器
  if (sessions.length > 0 && !resumed) {
    return (
      <SessionSelector
        sessions={sessions}
        onSelect={handleSelectSession}
        onCancel={handleCancel}
      />
    );
  }

  // 已恢复会话，渲染正常界面
  return <BladeInterface {...props} />;
};

// 包装器组件 - 提供会话上下文和错误边界
export const AppWrapper: React.FC<AppProps> = (props) => {
  // 直接传递所有 props，保持 debug 字段的原始类型（支持过滤器）
  const processedProps = {
    ...props,
  };

  // 启动时从配置文件加载主题
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const configManager = ConfigManager.getInstance();
        await configManager.initialize();
        const config = configManager.getConfig();
        const savedTheme = config?.theme;

        if (savedTheme && themeManager.hasTheme(savedTheme)) {
          themeManager.setTheme(savedTheme);
          if (props.debug) {
            console.log(`✓ 已加载主题: ${savedTheme}`);
          }
        }
      } catch (error) {
        // 静默失败，使用默认主题
        if (props.debug) {
          console.warn('⚠️ 主题加载失败，使用默认主题:', error);
        }
      }
    };

    loadTheme();
  }, []); // 只在组件挂载时执行一次

  return (
    <ErrorBoundary>
      <AppProvider>
        <SessionProvider>
          <ResumeHandler {...processedProps} />
          <NotificationSystem />
        </SessionProvider>
      </AppProvider>
    </ErrorBoundary>
  );
};

export default AppWrapper;
