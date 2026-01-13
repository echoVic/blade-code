/**
 * 输入区域组件
 */

import { useState, useRef, useEffect } from 'react';

interface InputAreaProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onCancel?: () => void;
}

export function InputArea({
  onSend,
  disabled = false,
  isStreaming = false,
  onCancel,
}: InputAreaProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动调整高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.inputWrapper}>
        <textarea
          ref={textareaRef}
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Shift+Enter 换行)"
          disabled={disabled}
          rows={1}
        />
        <div style={styles.actions}>
          {isStreaming ? (
            <button
              style={{ ...styles.button, ...styles.cancelButton }}
              onClick={onCancel}
            >
              ⏹ 停止
            </button>
          ) : (
            <button
              style={{
                ...styles.button,
                ...styles.sendButton,
                ...(disabled || !input.trim() ? styles.buttonDisabled : {}),
              }}
              onClick={handleSubmit}
              disabled={disabled || !input.trim()}
            >
              发送 ↵
            </button>
          )}
        </div>
      </div>
      <div style={styles.hint}>
        按 Enter 发送，Shift+Enter 换行
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px 24px 24px',
    borderTop: '1px solid #30363d',
    backgroundColor: '#0d1117',
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '12px',
    maxWidth: '900px',
    margin: '0 auto',
    backgroundColor: '#161b22',
    borderRadius: '8px',
    border: '1px solid #30363d',
    padding: '12px',
  },
  textarea: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
    resize: 'none',
    color: '#e6edf3',
    fontSize: '14px',
    lineHeight: '1.6',
    fontFamily: 'inherit',
    minHeight: '24px',
    maxHeight: '200px',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  button: {
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  sendButton: {
    backgroundColor: '#238636',
    color: '#fff',
  },
  cancelButton: {
    backgroundColor: '#da3633',
    color: '#fff',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  hint: {
    textAlign: 'center',
    fontSize: '12px',
    color: '#8b949e',
    marginTop: '8px',
  },
};
