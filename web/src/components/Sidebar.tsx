/**
 * 侧边栏 - 会话列表
 */

import { useAppStore } from '../hooks/useStore';
import type { SessionInfo } from '../types/acp';

interface SidebarProps {
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function Sidebar({ onNewSession, onSelectSession }: SidebarProps) {
  const { sessions, currentSessionId, isLoading } = useAppStore();

  const formatTime = (time?: string) => {
    if (!time) return '';
    const date = new Date(time);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return date.toLocaleDateString('zh-CN');
  };

  return (
    <aside style={styles.sidebar}>
      <div style={styles.header}>
        <h2 style={styles.title}>⚔️ Blade Web</h2>
        <button
          style={styles.newButton}
          onClick={onNewSession}
          disabled={isLoading}
        >
          + 新对话
        </button>
      </div>

      <div style={styles.sessionList}>
        {sessions.length === 0 ? (
          <div style={styles.empty}>暂无历史会话</div>
        ) : (
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              onClick={() => onSelectSession(session.id)}
              formatTime={formatTime}
            />
          ))
        )}
      </div>
    </aside>
  );
}

interface SessionItemProps {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
  formatTime: (time?: string) => string;
}

function SessionItem({ session, isActive, onClick, formatTime }: SessionItemProps) {
  return (
    <div
      style={{
        ...styles.sessionItem,
        ...(isActive ? styles.sessionItemActive : {}),
      }}
      onClick={onClick}
    >
      <div style={styles.sessionTitle}>
        {session.title || `会话 ${session.id.slice(0, 8)}`}
      </div>
      <div style={styles.sessionMeta}>
        <span>{session.message_count} 条消息</span>
        <span>{formatTime(session.last_message_time)}</span>
      </div>
      {session.git_branch && (
        <div style={styles.sessionBranch}>
          🌿 {session.git_branch}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '280px',
    backgroundColor: '#161b22',
    borderRight: '1px solid #30363d',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  header: {
    padding: '16px',
    borderBottom: '1px solid #30363d',
  },
  title: {
    fontSize: '18px',
    fontWeight: '600',
    marginBottom: '12px',
    color: '#e6edf3',
  },
  newButton: {
    width: '100%',
    padding: '10px 16px',
    backgroundColor: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  sessionList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px',
  },
  empty: {
    padding: '24px',
    textAlign: 'center',
    color: '#8b949e',
    fontSize: '14px',
  },
  sessionItem: {
    padding: '12px',
    borderRadius: '6px',
    cursor: 'pointer',
    marginBottom: '4px',
    transition: 'background-color 0.2s',
  },
  sessionItemActive: {
    backgroundColor: '#21262d',
  },
  sessionTitle: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#e6edf3',
    marginBottom: '4px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionMeta: {
    fontSize: '12px',
    color: '#8b949e',
    display: 'flex',
    justifyContent: 'space-between',
  },
  sessionBranch: {
    fontSize: '11px',
    color: '#7ee787',
    marginTop: '4px',
  },
};
