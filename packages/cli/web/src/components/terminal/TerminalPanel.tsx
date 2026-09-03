import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';
import { useIsDark } from '@/store/SettingsStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import '@xterm/xterm/css/xterm.css';
import { Minus, Terminal as TerminalIcon, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface TerminalPanelProps {
  workspacePath?: string | null;
}

export const TerminalPanel = ({ workspacePath }: TerminalPanelProps) => {
  const t = useT();
  const historySurfaceSelection = useSessionStore(
    (state) => state.historySurfaceSelection
  );
  const { isTerminalOpen, toggleTerminal } = useAppStore();
  const [isMinimized, setIsMinimized] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const isDark = useIsDark();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const connect = useCallback(() => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const baseUrl = import.meta.env.DEV
      ? 'ws://localhost:4097/terminal/ws'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/terminal/ws`;
    const wsUrl = workspacePath
      ? `${baseUrl}?cwd=${encodeURIComponent(workspacePath)}`
      : baseUrl;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      xtermRef.current?.write(event.data);
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };
  }, [workspacePath]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const sendInput = useCallback((data: string) => {
    if (isHistorySurfaceActive(useSessionStore.getState().historySurfaceSelection))
      return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previousFocusRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!isTerminalOpen || !terminalRef.current || xtermRef.current) return;

    const lightTheme = {
      background: '#ffffff',
      foreground: '#111827',
      cursor: '#111827',
      cursorAccent: '#ffffff',
      selectionBackground: '#E5E7EB',
      black: '#111827',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#ca8a04',
      blue: '#2563eb',
      magenta: '#7c3aed',
      cyan: '#0891b2',
      white: '#111827',
      brightBlack: '#6b7280',
      brightRed: '#ef4444',
      brightGreen: '#22c55e',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#a855f7',
      brightCyan: '#22d3ee',
      brightWhite: '#111827',
    };

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      allowTransparency: true,
      scrollback: 10000,
      theme: isDark
        ? {
            background: '#0a0a0a',
            foreground: '#e4e4e7',
            cursor: '#e4e4e7',
            cursorAccent: '#0a0a0a',
            selectionBackground: '#3f3f46',
            black: '#18181b',
            red: '#ef4444',
            green: '#22c55e',
            yellow: '#eab308',
            blue: '#3b82f6',
            magenta: '#a855f7',
            cyan: '#06b6d4',
            white: '#e4e4e7',
            brightBlack: '#52525b',
            brightRed: '#f87171',
            brightGreen: '#4ade80',
            brightYellow: '#facc15',
            brightBlue: '#60a5fa',
            brightMagenta: '#c084fc',
            brightCyan: '#22d3ee',
            brightWhite: '#fafafa',
          }
        : lightTheme,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);

    fitAddon.fit();
    const focusFrame = requestAnimationFrame(() => term.focus());

    term.onData((data: string) => {
      sendInput(data);
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    connect();

    return () => {
      cancelAnimationFrame(focusFrame);
      disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySurfaceSelection, isTerminalOpen, connect, disconnect, sendInput]);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme = isDark
      ? {
          background: '#0a0a0a',
          foreground: '#e4e4e7',
          cursor: '#e4e4e7',
          cursorAccent: '#0a0a0a',
          selectionBackground: '#3f3f46',
          black: '#18181b',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#eab308',
          blue: '#3b82f6',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#e4e4e7',
          brightBlack: '#52525b',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#fafafa',
        }
      : {
          background: '#ffffff',
          foreground: '#111827',
          cursor: '#111827',
          cursorAccent: '#ffffff',
          selectionBackground: '#E5E7EB',
          black: '#111827',
          red: '#dc2626',
          green: '#16a34a',
          yellow: '#ca8a04',
          blue: '#2563eb',
          magenta: '#7c3aed',
          cyan: '#0891b2',
          white: '#111827',
          brightBlack: '#6b7280',
          brightRed: '#ef4444',
          brightGreen: '#22c55e',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#a855f7',
          brightCyan: '#22d3ee',
          brightWhite: '#111827',
        };
  }, [isDark]);

  useEffect(() => {
    if (!isTerminalOpen || isMinimized) return;

    const handleResize = () => {
      fitAddonRef.current?.fit();
    };

    window.addEventListener('resize', handleResize);
    const timer = setTimeout(handleResize, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
    };
  }, [isTerminalOpen, isMinimized]);

  if (!isTerminalOpen || isHistorySurfaceActive(historySurfaceSelection)) return null;

  return (
    <div
      role="region"
      aria-label={t('terminal.title')}
      className={cn(
        'fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-[#0a0a0a] border-t border-[#E5E7EB] dark:border-zinc-800 transition-all duration-200',
        isMinimized ? 'h-10' : 'h-[min(18rem,45dvh)]'
      )}
    >
      <div className="flex items-center justify-between h-10 px-3 border-b border-[#E5E7EB] dark:border-zinc-800 bg-[#F9FAFB] dark:bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-4 w-4 text-[#9CA3AF] dark:text-zinc-400" />
          <span className="text-sm text-[#6B7280] dark:text-zinc-400">
            {t('terminal.title')}
          </span>
          <span
            role="status"
            aria-label={
              isConnected
                ? t('terminal.status.connected')
                : t('terminal.status.disconnected')
            }
            className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-green-500' : 'bg-zinc-600'
            )}
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            aria-label={
              isMinimized ? t('terminal.action.restore') : t('terminal.action.minimize')
            }
            className="p-1.5 rounded hover:bg-[#E5E7EB] text-[#9CA3AF] hover:text-[#111827] dark:hover:bg-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              disconnect();
              toggleTerminal();
            }}
            aria-label={t('terminal.action.close')}
            className="p-1.5 rounded hover:bg-[#E5E7EB] text-[#9CA3AF] hover:text-[#111827] dark:hover:bg-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={terminalRef}
        className={cn('h-[calc(100%-40px)] p-2', isMinimized && 'hidden')}
      />
    </div>
  );
};
