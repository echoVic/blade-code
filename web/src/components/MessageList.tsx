/**
 * 消息列表组件
 */

import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage } from '../hooks/useStore';

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div style={styles.welcome}>
        <div style={styles.welcomeIcon}>⚔️</div>
        <h1 style={styles.welcomeTitle}>Blade Web</h1>
        <p style={styles.welcomeText}>AI 编码助手</p>
        <p style={styles.welcomeHint}>输入消息开始对话</p>
      </div>
    );
  }

  return (
    <div style={styles.messageList}>
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}

interface MessageItemProps {
  message: ChatMessage;
}

function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div
      style={{
        ...styles.messageItem,
        ...(isUser ? styles.userMessage : styles.agentMessage),
      }}
    >
      <div style={styles.messageHeader}>
        <span style={styles.roleIcon}>{isUser ? '👤' : '🤖'}</span>
        <span style={styles.roleName}>{isUser ? '你' : 'Blade'}</span>
        {message.isStreaming && <span style={styles.streaming}>●</span>}
      </div>
      <div style={styles.messageContent}>
        <ReactMarkdown
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const isInline = !match;

              if (isInline) {
                return (
                  <code style={styles.inlineCode} {...props}>
                    {children}
                  </code>
                );
              }

              return (
                <SyntaxHighlighter
                  style={vscDarkPlus}
                  language={match[1]}
                  PreTag="div"
                  customStyle={styles.codeBlock}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  welcome: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#8b949e',
  },
  welcomeIcon: {
    fontSize: '64px',
    marginBottom: '16px',
  },
  welcomeTitle: {
    fontSize: '32px',
    fontWeight: '600',
    color: '#e6edf3',
    marginBottom: '8px',
  },
  welcomeText: {
    fontSize: '18px',
    marginBottom: '24px',
  },
  welcomeHint: {
    fontSize: '14px',
    padding: '8px 16px',
    backgroundColor: '#21262d',
    borderRadius: '6px',
  },
  messageList: {
    padding: '16px 24px',
    maxWidth: '900px',
    margin: '0 auto',
    width: '100%',
  },
  messageItem: {
    marginBottom: '24px',
    padding: '16px',
    borderRadius: '8px',
  },
  userMessage: {
    backgroundColor: '#1c2128',
  },
  agentMessage: {
    backgroundColor: '#0d1117',
    border: '1px solid #30363d',
  },
  messageHeader: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '12px',
  },
  roleIcon: {
    fontSize: '16px',
    marginRight: '8px',
  },
  roleName: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#e6edf3',
  },
  streaming: {
    marginLeft: '8px',
    color: '#238636',
    animation: 'pulse 1s infinite',
  },
  messageContent: {
    fontSize: '14px',
    lineHeight: '1.6',
    color: '#e6edf3',
  },
  inlineCode: {
    backgroundColor: '#343942',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
  },
  codeBlock: {
    borderRadius: '6px',
    margin: '12px 0',
    fontSize: '13px',
  },
};
