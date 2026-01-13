/**
 * 错误边界组件
 *
 * 捕获子组件的渲染错误，防止白屏
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.container}>
          <div style={styles.content}>
            <div style={styles.icon}>⚠️</div>
            <h1 style={styles.title}>出错了</h1>
            <p style={styles.message}>
              {this.state.error?.message || '发生了未知错误'}
            </p>
            <button style={styles.button} onClick={this.handleReload}>
              刷新页面
            </button>
            <details style={styles.details}>
              <summary style={styles.summary}>错误详情</summary>
              <pre style={styles.stack}>{this.state.error?.stack}</pre>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    backgroundColor: '#0d1117',
    color: '#e6edf3',
    padding: '24px',
  },
  content: {
    textAlign: 'center',
    maxWidth: '600px',
  },
  icon: {
    fontSize: '64px',
    marginBottom: '16px',
  },
  title: {
    fontSize: '24px',
    fontWeight: '600',
    marginBottom: '12px',
  },
  message: {
    fontSize: '16px',
    color: '#8b949e',
    marginBottom: '24px',
  },
  button: {
    padding: '12px 24px',
    backgroundColor: '#238636',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
  },
  details: {
    marginTop: '24px',
    textAlign: 'left',
  },
  summary: {
    cursor: 'pointer',
    color: '#8b949e',
    fontSize: '14px',
  },
  stack: {
    marginTop: '12px',
    padding: '12px',
    backgroundColor: '#161b22',
    borderRadius: '6px',
    fontSize: '12px',
    overflow: 'auto',
    maxHeight: '200px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
};
