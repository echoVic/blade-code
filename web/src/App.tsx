/**
 * 主应用组件
 */

import { useCallback, useEffect, useRef } from 'react';
import { acpClient } from './api/acpClient';
import { InputArea } from './components/InputArea';
import { MessageList } from './components/MessageList';
import { Sidebar } from './components/Sidebar';
import { useAppStore, type ChatMessage } from './hooks/useStore';

export function App() {
  const {
    messages,
    config,
    currentSessionId,
    isLoading,
    isStreaming,
    error,
    setSessions,
    setCurrentSessionId,
    setMessages,
    addMessage,
    updateLastMessage,
    setConfig,
    setIsLoading,
    setIsStreaming,
    setError,
    clearMessages,
  } = useAppStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 初始化：加载配置和会话列表
  useEffect(() => {
    const init = async () => {
      try {
        // 并行加载配置和会话
        const [configData, sessions] = await Promise.all([
          acpClient.getConfig(),
          acpClient.listSessions(),
        ]);
        setConfig(configData);
        setSessions(sessions);
      } catch (err) {
        setError('加载失败：' + (err instanceof Error ? err.message : '未知错误'));
      }
    };
    init();
  }, [setConfig, setSessions, setError]);

  // 消息变化时滚动到底部
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 创建新会话
  const handleNewSession = useCallback(() => {
    setCurrentSessionId(null);
    clearMessages();
  }, [setCurrentSessionId, clearMessages]);

  // 选择会话
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      try {
        setIsLoading(true);
        setCurrentSessionId(sessionId);

        // 加载会话消息
        const { messages: acpMessages } = await acpClient.getSessionMessages(sessionId);
        const chatMessages: ChatMessage[] = acpMessages.map((msg, index) => ({
          id: `${sessionId}-${index}`,
          role: msg.role,
          content: msg.parts.map((p) => p.content || '').join('\n'),
          timestamp: new Date(msg.created_at || Date.now()),
        }));
        setMessages(chatMessages);
      } catch (err) {
        setError('加载会话失败：' + (err instanceof Error ? err.message : '未知错误'));
      } finally {
        setIsLoading(false);
      }
    },
    [setCurrentSessionId, setMessages, setIsLoading, setError]
  );

  // 发送消息
  const handleSendMessage = useCallback(
    async (content: string) => {
      try {
        setError(null);

        // 添加用户消息
        const userMessage: ChatMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          content,
          timestamp: new Date(),
        };
        addMessage(userMessage);

        // 创建 Agent 响应占位
        const agentMessage: ChatMessage = {
          id: `agent-${Date.now()}`,
          role: 'agent',
          content: '',
          timestamp: new Date(),
          isStreaming: true,
        };
        addMessage(agentMessage);

        setIsStreaming(true);

        // 创建 AbortController
        abortControllerRef.current = new AbortController();

        // 构造 ACP 消息
        const acpInput = [
          {
            role: 'user' as const,
            parts: [{ content_type: 'text/plain', content }],
          },
        ];

        // 使用流式模式
        let fullContent = '';
        for await (const event of acpClient.createStreamRun(
          'blade-code',
          acpInput,
          currentSessionId || undefined,
          abortControllerRef.current.signal
        )) {
          if (event.event === 'message.part') {
            const data = event.data as { output?: Array<{ parts: Array<{ content?: string }> }> };
            if (data.output && data.output[0]?.parts[0]?.content) {
              fullContent = data.output[0].parts[0].content;
              updateLastMessage(fullContent);
            }
          } else if (event.event === 'run.completed') {
            const data = event.data as { output?: Array<{ parts: Array<{ content?: string }> }> };
            if (data.output && data.output[0]?.parts[0]?.content) {
              fullContent = data.output[0].parts[0].content;
              updateLastMessage(fullContent);
            }
          }
        }

        // 更新最终消息（移除 streaming 标记）
        const finalMessages = useAppStore.getState().messages;
        setMessages(
          finalMessages.map((msg) =>
            msg.id === agentMessage.id ? { ...msg, isStreaming: false } : msg
          )
        );

        // 刷新会话列表
        const sessions = await acpClient.listSessions();
        setSessions(sessions);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // 用户取消，不显示错误
        } else {
          setError('发送失败：' + (err instanceof Error ? err.message : '未知错误'));
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [
      currentSessionId,
      addMessage,
      updateLastMessage,
      setMessages,
      setIsStreaming,
      setError,
      setSessions,
    ]
  );

  // 取消流式响应
  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return (
    <div style={styles.app}>
      <Sidebar
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
      />
      <main style={styles.main}>
        {/* 头部信息 */}
        <header style={styles.header}>
          <div style={styles.projectPath}>
            📁 {config?.project_path || '加载中...'}
          </div>
          {error && <div style={styles.error}>{error}</div>}
        </header>

        {/* 消息区域 */}
        <div style={styles.messagesContainer}>
          <MessageList messages={messages} />
          <div ref={messagesEndRef} />
        </div>

        {/* 输入区域 */}
        <InputArea
          onSend={handleSendMessage}
          disabled={isLoading}
          isStreaming={isStreaming}
          onCancel={handleCancel}
        />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    height: '100vh',
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 24px',
    borderBottom: '1px solid #30363d',
    backgroundColor: '#161b22',
  },
  projectPath: {
    fontSize: '14px',
    color: '#8b949e',
  },
  error: {
    marginTop: '8px',
    padding: '8px 12px',
    backgroundColor: '#da363322',
    border: '1px solid #da3633',
    borderRadius: '6px',
    fontSize: '13px',
    color: '#f85149',
  },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    backgroundColor: '#0d1117',
  },
};
