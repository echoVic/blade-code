import {
  type LucideIcon,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { type TranslationKey, useT } from '@/i18n';
import { shortcutHint } from '@/lib/keyboardShortcuts';
import { cn } from '@/lib/utils';
import { BladeMark } from './BladeMark';
import { LanguageSwitcher } from './LanguageSwitcher';

interface SidebarCollapsedProps {
  onExpand: () => void;
  onNewChat: () => void;
  onOpenTaskSwitcher: () => void;
  onToggleTerminal: () => void;
  onToggleSkills: () => void;
  onToggleMcp: () => void;
  onToggleSettings: () => void;
  isTerminalOpen: boolean;
  taskEventsConnected: boolean;
  unreadCount: number;
  className?: string;
}

/**
 * Compact rail variant of the Sidebar.
 * Split from Sidebar.tsx to keep both files under the 300-line house rule.
 */
export function SidebarCollapsed({
  onExpand,
  onNewChat,
  onOpenTaskSwitcher,
  onToggleTerminal,
  onToggleSkills,
  onToggleMcp,
  onToggleSettings,
  isTerminalOpen,
  taskEventsConnected,
  unreadCount,
  className,
}: SidebarCollapsedProps) {
  const t = useT();
  const footerActions: Array<{
    icon: LucideIcon;
    action: () => void;
    labelKey: TranslationKey;
  }> = [
    { icon: Sparkles, action: onToggleSkills, labelKey: 'sidebar.section.skills' },
    { icon: Server, action: onToggleMcp, labelKey: 'sidebar.section.mcp' },
    { icon: Settings, action: onToggleSettings, labelKey: 'sidebar.section.settings' },
  ];

  return (
    <div
      className={cn(
        'flex flex-col gap-2 items-center py-5 h-screen border-r w-[64px] border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))]',
        className
      )}
    >
      <button
        onClick={onExpand}
        className="rounded-md p-1 transition-colors hover:bg-[hsl(var(--deck-surface))]"
        aria-label={t('sidebar.action.expand')}
      >
        <BladeMark size={28} />
      </button>

      <button
        onClick={onNewChat}
        aria-label={t('sidebar.action.newTaskShort')}
        title={t('sidebar.action.newTaskShort')}
        className="mt-6 flex h-10 w-10 items-center justify-center rounded-md bg-[hsl(var(--deck-ink))] text-[hsl(var(--deck-canvas))] transition-colors hover:bg-[hsl(var(--deck-ink))]/85"
      >
        <Plus className="h-4 w-4 stroke-[2.5]" />
      </button>

      <button
        onClick={onToggleTerminal}
        aria-label={t('sidebar.action.terminalToggle')}
        title={t('sidebar.action.terminal')}
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-md border transition-colors',
          isTerminalOpen
            ? 'border-[hsl(var(--deck-accent)/0.55)] bg-[hsl(var(--deck-accent-soft))] text-[hsl(var(--deck-accent))]'
            : 'border-transparent text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]'
        )}
      >
        <Terminal className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenTaskSwitcher}
        aria-label={t('sidebar.action.searchTasks')}
        title={`${t('sidebar.action.searchTasks')} (${shortcutHint('searchTasks')})`}
        className="relative flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-[hsl(var(--deck-ink-muted))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
      >
        <Search className="h-4 w-4" />
        {unreadCount > 0 && (
          <span
            aria-label={t('sidebar.unreadTasks', { count: unreadCount })}
            className="absolute right-0.5 top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-[hsl(var(--deck-accent))] px-1 font-mono text-[8px] font-semibold text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <div className="flex-1" />

      <div className="my-2 h-px w-6 bg-[hsl(var(--deck-hairline))]" />

      {footerActions.map(({ icon: Icon, action, labelKey }) => (
        <button
          key={labelKey}
          onClick={action}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]"
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}

      <LanguageSwitcher variant="compact" />

      <div className="mt-1">
        <div
          role="status"
          aria-label={
            taskEventsConnected
              ? t('sidebar.status.feedLive')
              : t('sidebar.status.feedOffline')
          }
          className={cn(
            'h-2 w-2 rounded-full',
            taskEventsConnected
              ? 'bg-[hsl(var(--deck-accent))] shadow-[0_0_6px_hsl(var(--deck-accent-glow)/0.9)]'
              : 'bg-[hsl(var(--deck-ink-faint))]/60'
          )}
          title={
            taskEventsConnected
              ? t('sidebar.status.feedLive')
              : t('sidebar.status.feedOffline')
          }
        />
      </div>
    </div>
  );
}
