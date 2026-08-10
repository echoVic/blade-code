import type { SessionRef } from '@api/schemas';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type TranslationKey, useT } from '@/i18n';
import {
  applyProjectOrder,
  moveProjectPath,
  moveProjectPathBy,
  persistProjectOrder,
  readProjectOrder,
} from '@/lib/projectOrder';
import { cn } from '@/lib/utils';
import type { BoundProject, Session } from '@/services';
import type { CatalogLoadState } from '@/store/session';
import {
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import { groupByProject, groupByStatus, type SidebarView } from './sidebarGrouping';

const INITIAL_SESSIONS_PER_GROUP = 12;

const STATUS_LABEL: Record<string, TranslationKey> = {
  RUNNING: 'sidebar.group.running',
  QUEUED: 'sidebar.group.queued',
  INTERRUPTED: 'sidebar.group.interrupted',
  FAILED: 'sidebar.group.failed',
  CANCELLED: 'sidebar.group.cancelled',
  DONE: 'sidebar.group.done',
};

const STATUS_ACCENT: Record<string, string> = {
  RUNNING: 'text-blue-700 dark:text-blue-400',
  QUEUED: 'text-amber-700 dark:text-amber-400',
  INTERRUPTED: 'text-orange-700 dark:text-orange-400',
  FAILED: 'text-red-700 dark:text-red-400',
  CANCELLED: 'text-[hsl(var(--deck-ink-faint))]',
  DONE: 'text-[hsl(var(--deck-accent))]',
};

export interface SidebarSessionListProps {
  view: SidebarView;
  sessions: Session[];
  activeProjectPath: string | null;
  boundProjects: BoundProject[];
  currentSessionRef: SessionRef | null;
  unreadTaskKeys: string[];
  catalogLoadState: CatalogLoadState;
  catalogError: string | null;
  onSelectProject: (projectPath: string) => void;
  onCreateTask: (projectPath: string) => void;
  onRetryCatalog: () => void;
  renderRow: (session: Session) => React.ReactNode;
}

/**
 * Renders the sidebar session buckets for either the project-first or the
 * status-first view. Extracted from Sidebar.tsx to keep files small and to
 * localize the collapse state for project groups.
 */
export function SidebarSessionList({
  view,
  sessions,
  activeProjectPath,
  boundProjects,
  currentSessionRef,
  unreadTaskKeys,
  catalogLoadState,
  catalogError,
  onSelectProject,
  onCreateTask,
  onRetryCatalog,
  renderRow,
}: SidebarSessionListProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [projectOrder, setProjectOrder] = useState(readProjectOrder);
  const [draggedProjectPath, setDraggedProjectPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const catalogBusy =
    catalogLoadState === 'loading' || catalogLoadState === 'hydrating';
  const countIsPartial = catalogBusy || catalogLoadState === 'error';
  const statusGroups = useMemo(
    () => (view === 'status' ? groupByStatus(sessions) : []),
    [sessions, view]
  );
  const groupedProjects = useMemo(
    () =>
      view === 'project'
        ? groupByProject(
            sessions,
            activeProjectPath,
            boundProjects.map((project) => project.path)
          )
        : [],
    [activeProjectPath, boundProjects, sessions, view]
  );
  const projectGroups = useMemo(
    () => applyProjectOrder(groupedProjects, projectOrder),
    [groupedProjects, projectOrder]
  );

  const renderSessions = (key: string, groupSessions: Session[]) => {
    const expanded = expandedGroups[key] ?? false;
    const visibleSessions = expanded
      ? groupSessions
      : groupSessions.filter((session, index) => {
          if (index < INITIAL_SESSIONS_PER_GROUP) return true;
          const ref = sessionRefFromSession(session);
          return (
            Boolean(session.pendingInteraction) ||
            unreadTaskKeys.includes(sessionRefKey(ref)) ||
            Boolean(currentSessionRef && sameSessionRef(ref, currentSessionRef))
          );
        });
    const hiddenCount = groupSessions.length - visibleSessions.length;
    const canToggle = expanded
      ? groupSessions.length > INITIAL_SESSIONS_PER_GROUP
      : hiddenCount > 0;

    return (
      <>
        {visibleSessions.map(renderRow)}
        {canToggle && (
          <button
            type="button"
            onClick={() =>
              setExpandedGroups((previous) => ({
                ...previous,
                [key]: !expanded,
              }))
            }
            className="mx-4 my-1 rounded-md px-3 py-1.5 text-left font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink-muted))]"
          >
            {expanded
              ? t('sidebar.group.showLess')
              : t('sidebar.group.showMore', {
                  count: hiddenCount,
                })}
          </button>
        )}
      </>
    );
  };

  const catalogNotice = catalogBusy ? (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-2 flex items-center gap-2 rounded-md bg-[hsl(var(--deck-surface))]/55 px-3 py-2 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]"
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
      <span className="flex-1 min-w-0">{t('sidebar.catalog.syncing')}</span>
      <span className="tabular-nums shrink-0">
        {t('sidebar.catalog.loaded', { count: sessions.length })}
      </span>
    </div>
  ) : catalogLoadState === 'error' ? (
    <div
      role="alert"
      title={catalogError ?? undefined}
      className="mx-4 mt-2 flex items-center gap-2 rounded-md bg-amber-50/80 px-3 py-2 font-mono text-[9.5px] text-amber-800 dark:bg-amber-950/35 dark:text-amber-300"
    >
      <AlertCircle className="w-3 h-3 shrink-0" />
      <span className="flex-1 min-w-0">{t('sidebar.catalog.incomplete')}</span>
      <button
        type="button"
        onClick={onRetryCatalog}
        className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded px-1.5 font-medium hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 dark:hover:bg-amber-900/50"
      >
        <RefreshCw className="h-2.5 w-2.5" />
        {t('sidebar.catalog.retry')}
      </button>
    </div>
  ) : null;

  if (view === 'status') {
    return (
      <div className="flex flex-col">
        {catalogNotice}
        {statusGroups.map((group, index) => (
          <div key={group.code}>
            <div
              className={cn(
                'flex items-center justify-between px-5 pb-2 pt-3 font-mono text-[10px] tracking-[0.16em]',
                STATUS_ACCENT[group.code] ?? 'text-[hsl(var(--deck-ink-faint))]',
                index === 0 && 'pt-2'
              )}
            >
              <span>{t(STATUS_LABEL[group.code])}</span>
              <span className="text-[hsl(var(--deck-ink-faint))]">
                {group.sessions.length.toString().padStart(2, '0')}
                {countIsPartial ? '+' : ''}
              </span>
            </div>
            {renderSessions(`status:${group.code}`, group.sessions)}
          </div>
        ))}
      </div>
    );
  }

  const hasActiveGroup = projectGroups.some((group) => group.isActive);
  const groupContainsCurrent = (group: (typeof projectGroups)[number]) =>
    Boolean(
      currentSessionRef &&
        group.sessions.some((session) =>
          sameSessionRef(sessionRefFromSession(session), currentSessionRef)
        )
    );

  const commitProjectOrder = (nextOrder: string[], movedPath: string) => {
    if (nextOrder.join('\0') === projectGroups.map((group) => group.path).join('\0')) {
      return;
    }
    setProjectOrder(nextOrder);
    persistProjectOrder(nextOrder);
    const movedGroup = projectGroups.find((group) => group.path === movedPath);
    setReorderAnnouncement(
      t('sidebar.project.reordered', {
        name: movedGroup?.name ?? movedPath,
        position: nextOrder.indexOf(movedPath) + 1,
      })
    );
  };

  const renderProjectGroup = (
    group: (typeof projectGroups)[number],
    projectIndex: number
  ) => {
    const unreadCount = group.sessions.filter((session) =>
      unreadTaskKeys.includes(sessionRefKey(sessionRefFromSession(session)))
    ).length;
    const containsCurrent = groupContainsCurrent(group);
    const hasUnread = unreadCount > 0;
    const hasPendingInteraction = group.sessions.some((session) =>
      Boolean(session.pendingInteraction)
    );
    const isCollapsed =
      collapsed[group.path] ??
      (hasActiveGroup &&
        !group.isActive &&
        !(containsCurrent || group.hasRunning || hasUnread || hasPendingInteraction));
    return (
      <div
        key={group.path}
        data-project-group={group.path}
        onDragEnter={(event) => {
          if (!draggedProjectPath || draggedProjectPath === group.path) return;
          event.preventDefault();
          setDropTargetPath(group.path);
        }}
        onDragOver={(event) => {
          if (!draggedProjectPath || draggedProjectPath === group.path) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourcePath =
            draggedProjectPath || event.dataTransfer.getData('text/plain');
          if (sourcePath && sourcePath !== group.path) {
            commitProjectOrder(
              moveProjectPath(
                projectGroups.map((project) => project.path),
                sourcePath,
                group.path
              ),
              sourcePath
            );
          }
          setDraggedProjectPath(null);
          setDropTargetPath(null);
        }}
        className={cn(
          'relative transition-colors',
          dropTargetPath === group.path &&
            draggedProjectPath !== group.path &&
            'bg-[hsl(var(--deck-accent-soft))]/55 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-[hsl(var(--deck-accent))]'
        )}
      >
        <ProjectGroupHeader
          name={group.name}
          path={group.path}
          count={group.sessions.length}
          countIsPartial={countIsPartial}
          isActive={group.isActive}
          hasRunning={group.hasRunning}
          unreadCount={unreadCount}
          collapsed={isCollapsed}
          onSelect={() => onSelectProject(group.path)}
          onCreateTask={() => onCreateTask(group.path)}
          reorderPosition={projectIndex + 1}
          reorderCount={projectGroups.length}
          isDragging={draggedProjectPath === group.path}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', group.path);
            setDraggedProjectPath(group.path);
          }}
          onDragEnd={() => {
            setDraggedProjectPath(null);
            setDropTargetPath(null);
          }}
          onReorderKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const nextOrder = moveProjectPathBy(
              projectGroups.map((project) => project.path),
              group.path,
              event.key === 'ArrowUp' ? -1 : 1
            );
            commitProjectOrder(nextOrder, group.path);
          }}
          onToggle={() =>
            setCollapsed((prev) => ({
              ...prev,
              [group.path]: !isCollapsed,
            }))
          }
        />
        {!isCollapsed && renderSessions(`project:${group.path}`, group.sessions)}
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      <span className="sr-only" aria-live="polite">
        {reorderAnnouncement}
      </span>
      {catalogNotice}
      {projectGroups.length > 0 && (
        <>
          <div className="px-5 pb-0.5 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[hsl(var(--deck-ink-faint))]">
            {t('sidebar.project.projects')}
          </div>
          {projectGroups.map(renderProjectGroup)}
        </>
      )}
    </div>
  );
}
