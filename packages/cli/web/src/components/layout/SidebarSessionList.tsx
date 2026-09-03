import type { SessionRef, SessionSurfaceSummary } from '@api/schemas';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type TranslationKey, useT } from '@/i18n';
import { projectNameOf, projectPathOf } from '@/lib/projectIdentity';
import {
  applyProjectOrder,
  moveProjectPath,
  moveProjectPathBy,
  persistProjectOrder,
  readProjectOrder,
} from '@/lib/projectOrder';
import { cn } from '@/lib/utils';
import type { BoundProject, Session } from '@/services';
import type { CatalogLoadState, SessionSurfaceSelection } from '@/store/session';
import {
  sameSessionRef,
  sameSurfaceLocator,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import { groupByProject, groupByStatus, type SidebarView } from './sidebarGrouping';

const INITIAL_SESSIONS_PER_GROUP = 12;
const TASK_STATUS_ORDER: Session['taskStatus'][] = [
  'running',
  'queued',
  'interrupted',
  'failed',
  'cancelled',
  'completed',
];

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

const STATUS_GROUP_CODE: Record<Session['taskStatus'], keyof typeof STATUS_LABEL> = {
  running: 'RUNNING',
  queued: 'QUEUED',
  interrupted: 'INTERRUPTED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  completed: 'DONE',
};

export interface SidebarSessionListProps {
  view: SidebarView;
  sessions: Session[];
  surfaceCatalog: SessionSurfaceSummary[];
  activeProjectPath: string | null;
  boundProjects: BoundProject[];
  currentSessionRef: SessionRef | null;
  historySurfaceSelection: SessionSurfaceSelection | null;
  unreadTaskKeys: string[];
  catalogLoadState: CatalogLoadState;
  onSelectProject: (projectPath: string) => void;
  onCreateTask: (projectPath: string) => void;
  onRetryCatalog: () => void;
  renderLocalRow: (session: Session) => React.ReactNode;
  renderRemoteRow: (summary: SessionSurfaceSummary) => React.ReactNode;
}

type CatalogEntry =
  | {
      kind: 'local';
      path: string;
      activityTime: number;
      session: Session;
    }
  | {
      kind: 'remote';
      activityTime: number;
      summary: SessionSurfaceSummary;
    };

interface CatalogProjectGroup {
  path: string;
  name: string;
  isActive: boolean;
  isBound: boolean;
  hasRunning: boolean;
  lastActivity: number;
  entries: CatalogEntry[];
}

function normalizeProjectPath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function catalogActivityTime(summary: SessionSurfaceSummary): number {
  const raw = summary.lastMessageTime || summary.firstMessageTime;
  if (!raw) return 0;
  const value = new Date(raw).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function localSessionFromSummary(
  summary: SessionSurfaceSummary,
  legacySession: Session | undefined
): Session {
  if (summary.locator.workspace.kind !== 'local') {
    throw new Error('Expected a local Session surface summary');
  }

  const base: Session = legacySession ?? {
    sessionId: summary.locator.sessionId,
    projectPath: summary.locator.workspace.projectPath,
    rootId: summary.rootId,
    taskStatus: summary.taskStatus,
    messageCount: summary.messageCount,
    firstMessageTime: summary.firstMessageTime,
    lastMessageTime: summary.lastMessageTime,
    hasErrors: summary.hasErrors,
  };

  return {
    ...base,
    sessionId: summary.locator.sessionId,
    projectPath: summary.locator.workspace.projectPath,
    title: summary.title,
    rootId: summary.rootId,
    parentId: summary.parentId,
    relationType: summary.relationType,
    taskStatus: summary.taskStatus,
    messageCount: summary.messageCount,
    firstMessageTime: summary.firstMessageTime,
    lastMessageTime: summary.lastMessageTime,
    hasErrors: summary.hasErrors,
    archivedAt: summary.archivedAt,
    selectedModelId: summary.selectedModelId,
  };
}

function entryTaskStatus(entry: CatalogEntry): Session['taskStatus'] {
  return entry.kind === 'local' ? entry.session.taskStatus : entry.summary.taskStatus;
}

function compareCatalogEntries(left: CatalogEntry, right: CatalogEntry): number {
  return right.activityTime - left.activityTime;
}

function sortCatalogEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort(compareCatalogEntries);
}

/**
 * Renders the sidebar session buckets for either the project-first or the
 * status-first view. Extracted from Sidebar.tsx to keep files small and to
 * localize the collapse state for project groups.
 */
export function SidebarSessionList({
  view,
  sessions,
  surfaceCatalog,
  activeProjectPath,
  boundProjects,
  currentSessionRef,
  historySurfaceSelection,
  unreadTaskKeys,
  catalogLoadState,
  onSelectProject,
  onCreateTask,
  onRetryCatalog,
  renderLocalRow,
  renderRemoteRow,
}: SidebarSessionListProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [projectOrder, setProjectOrder] = useState(readProjectOrder);
  const [draggedProjectPath, setDraggedProjectPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const usingSurfaceCatalog = catalogLoadState === 'ready' || surfaceCatalog.length > 0;
  const catalogBusy =
    catalogLoadState === 'loading' || catalogLoadState === 'hydrating';
  const countIsPartial = catalogBusy || catalogLoadState === 'error';
  const loadedCount = usingSurfaceCatalog ? surfaceCatalog.length : sessions.length;
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
  const catalogEntries = useMemo(() => {
    if (!usingSurfaceCatalog) return [] as CatalogEntry[];

    const localSessions = new Map(
      sessions.map((session) => [
        sessionRefKey(sessionRefFromSession(session)),
        session,
      ])
    );
    const entries: CatalogEntry[] = [];

    for (const summary of surfaceCatalog) {
      if (summary.locator.workspace.kind === 'local') {
        const ref = {
          sessionId: summary.locator.sessionId,
          projectPath: summary.locator.workspace.projectPath,
        };
        const legacySession = localSessions.get(sessionRefKey(ref));
        const session = localSessionFromSummary(summary, legacySession);
        entries.push({
          kind: 'local',
          path: legacySession
            ? projectPathOf(session, activeProjectPath)
            : summary.locator.workspace.projectPath,
          activityTime: catalogActivityTime(summary),
          session,
        });
        continue;
      }

      entries.push({
        kind: 'remote',
        activityTime: catalogActivityTime(summary),
        summary,
      });
    }

    return entries;
  }, [activeProjectPath, sessions, surfaceCatalog, usingSurfaceCatalog]);
  const catalogStatusGroups = useMemo(() => {
    if (!usingSurfaceCatalog || view !== 'status')
      return [] as Array<{
        code: keyof typeof STATUS_LABEL;
        entries: CatalogEntry[];
      }>;

    return TASK_STATUS_ORDER.flatMap((status) => {
      const entries = sortCatalogEntries(
        catalogEntries.filter((entry) => entryTaskStatus(entry) === status)
      );
      if (entries.length === 0) return [];
      return [
        {
          code: STATUS_GROUP_CODE[status],
          entries,
        },
      ];
    });
  }, [catalogEntries, usingSurfaceCatalog, view]);
  const catalogProjectGroups = useMemo(() => {
    if (!usingSurfaceCatalog || view !== 'project') return [] as CatalogProjectGroup[];

    const normalizedBoundPaths = boundProjects.map((project) =>
      normalizeProjectPath(project.path)
    );
    const boundOrder = new Map(
      normalizedBoundPaths.map((projectPath, index) => [projectPath, index])
    );
    const buckets = new Map<string, CatalogEntry[]>();

    for (const projectPath of normalizedBoundPaths) {
      buckets.set(projectPath, []);
    }
    for (const entry of catalogEntries) {
      if (entry.kind !== 'local') continue;
      const bucket = buckets.get(entry.path);
      if (bucket) bucket.push(entry);
      else buckets.set(entry.path, [entry]);
    }

    const normalizedActive = activeProjectPath
      ? normalizeProjectPath(activeProjectPath)
      : null;
    const groups: CatalogProjectGroup[] = Array.from(buckets.entries()).map(
      ([path, entries]) => ({
        path,
        name: projectNameOf(path),
        isActive: normalizedActive
          ? normalizeProjectPath(path) === normalizedActive
          : false,
        isBound: boundOrder.has(normalizeProjectPath(path)),
        hasRunning: entries.some((entry) => entryTaskStatus(entry) === 'running'),
        lastActivity: entries.reduce(
          (max, entry) => Math.max(max, entry.activityTime),
          0
        ),
        entries: sortCatalogEntries(entries),
      })
    );

    groups.sort((left, right) => {
      if (left.isBound !== right.isBound) return left.isBound ? -1 : 1;
      if (left.isBound && right.isBound) {
        return (
          (boundOrder.get(normalizeProjectPath(left.path)) ?? Number.MAX_SAFE_INTEGER) -
          (boundOrder.get(normalizeProjectPath(right.path)) ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return right.lastActivity - left.lastActivity;
    });

    return applyProjectOrder(groups, projectOrder);
  }, [
    activeProjectPath,
    boundProjects,
    catalogEntries,
    projectOrder,
    usingSurfaceCatalog,
    view,
  ]);
  const catalogRemoteEntries = useMemo(
    () =>
      view === 'project'
        ? sortCatalogEntries(catalogEntries.filter((entry) => entry.kind === 'remote'))
        : [],
    [catalogEntries, view]
  );

  const entryHasPendingInteraction = (entry: CatalogEntry) =>
    entry.kind === 'local' && Boolean(entry.session.pendingInteraction);
  const entryIsUnread = (entry: CatalogEntry) =>
    entry.kind === 'local' &&
    unreadTaskKeys.includes(sessionRefKey(sessionRefFromSession(entry.session)));
  const entryIsActive = (entry: CatalogEntry) =>
    entry.kind === 'local'
      ? Boolean(
          currentSessionRef &&
            sameSessionRef(sessionRefFromSession(entry.session), currentSessionRef)
        )
      : Boolean(
          historySurfaceSelection &&
            sameSurfaceLocator(entry.summary.locator, historySurfaceSelection.locator)
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
        {visibleSessions.map(renderLocalRow)}
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
  const renderCatalogEntriesGroup = (key: string, entries: CatalogEntry[]) => {
    const expanded = expandedGroups[key] ?? false;
    const visibleEntries = expanded
      ? entries
      : entries.filter((entry, index) => {
          if (index < INITIAL_SESSIONS_PER_GROUP) return true;
          return (
            entryHasPendingInteraction(entry) ||
            entryIsUnread(entry) ||
            entryIsActive(entry)
          );
        });
    const hiddenCount = entries.length - visibleEntries.length;
    const canToggle = expanded
      ? entries.length > INITIAL_SESSIONS_PER_GROUP
      : hiddenCount > 0;

    return (
      <>
        {visibleEntries.map((entry) =>
          entry.kind === 'local'
            ? renderLocalRow(entry.session)
            : renderRemoteRow(entry.summary)
        )}
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
        {t('sidebar.catalog.loaded', { count: loadedCount })}
      </span>
    </div>
  ) : catalogLoadState === 'error' ? (
    <div
      role="alert"
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

  if (usingSurfaceCatalog) {
    if (view === 'status') {
      return (
        <div className="flex flex-col">
          {catalogNotice}
          {catalogStatusGroups.map((group, index) => (
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
                  {group.entries.length.toString().padStart(2, '0')}
                  {countIsPartial ? '+' : ''}
                </span>
              </div>
              {renderCatalogEntriesGroup(`status:${group.code}`, group.entries)}
            </div>
          ))}
        </div>
      );
    }

    const hasActiveGroup = catalogProjectGroups.some(
      (group) => group.isActive || group.entries.some(entryIsActive)
    );
    const groupContainsCurrent = (group: CatalogProjectGroup) =>
      group.entries.some(entryIsActive);

    const commitProjectOrder = (nextOrder: string[], movedPath: string) => {
      if (
        nextOrder.join('\0') ===
        catalogProjectGroups.map((group) => group.path).join('\0')
      ) {
        return;
      }
      setProjectOrder(nextOrder);
      persistProjectOrder(nextOrder);
      const movedGroup = catalogProjectGroups.find((group) => group.path === movedPath);
      setReorderAnnouncement(
        t('sidebar.project.reordered', {
          name: movedGroup?.name ?? movedPath,
          position: nextOrder.indexOf(movedPath) + 1,
        })
      );
    };

    const renderCatalogProjectGroup = (
      group: CatalogProjectGroup,
      projectIndex: number
    ) => {
      const unreadCount = group.entries.filter(entryIsUnread).length;
      const containsCurrent = groupContainsCurrent(group);
      const hasUnread = unreadCount > 0;
      const hasPendingInteraction = group.entries.some(entryHasPendingInteraction);
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
                  catalogProjectGroups.map((project) => project.path),
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
            count={group.entries.length}
            countIsPartial={countIsPartial}
            isActive={group.isActive}
            hasRunning={group.hasRunning}
            unreadCount={unreadCount}
            collapsed={isCollapsed}
            onSelect={() => onSelectProject(group.path)}
            onCreateTask={() => onCreateTask(group.path)}
            reorderPosition={projectIndex + 1}
            reorderCount={catalogProjectGroups.length}
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
                catalogProjectGroups.map((project) => project.path),
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
          {!isCollapsed &&
            renderCatalogEntriesGroup(`project:${group.path}`, group.entries)}
        </div>
      );
    };

    return (
      <div className="flex flex-col">
        <span className="sr-only" aria-live="polite">
          {reorderAnnouncement}
        </span>
        {catalogNotice}
        {catalogRemoteEntries.length > 0 && (
          <section data-remote-session-group>
            <div className="flex items-center justify-between px-5 pb-2 pt-3 font-mono text-[10px] tracking-[0.16em] text-[hsl(var(--deck-ink-faint))]">
              <span>{t('sidebar.project.remoteSessions')}</span>
              <span>{catalogRemoteEntries.length.toString().padStart(2, '0')}</span>
            </div>
            {renderCatalogEntriesGroup('remote-sessions', catalogRemoteEntries)}
          </section>
        )}
        {catalogProjectGroups.length > 0 && (
          <>
            <div className="px-5 pb-0.5 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[hsl(var(--deck-ink-faint))]">
              {t('sidebar.project.projects')}
            </div>
            {catalogProjectGroups.map(renderCatalogProjectGroup)}
          </>
        )}
      </div>
    );
  }

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
