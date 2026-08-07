import { projectNameOf, projectPathOf } from '@/lib/projectIdentity';
import { compareTaskAttentionThenActivity, taskActivityTime } from '@/lib/taskOrdering';
import type { Session } from '@/services';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';

/**
 * Sidebar grouping helpers.
 *
 * The sidebar can organize sessions along two axes:
 *  - "project": first-class project dimension (a production coding-agent staple —
 *    see Codex / Grok Build). Sessions are bucketed by their source project path,
 *    project order remains stable when focus changes, and each project keeps its
 *    own status-aware task ordering.
 *  - "status": the original flat status buckets (running / queued / … / done).
 *
 * Kept in a standalone module so `Sidebar.tsx` stays under the house line budget.
 */

export type SidebarView = 'project' | 'status';

const TASK_STATUS_ORDER: Session['taskStatus'][] = [
  'running',
  'queued',
  'interrupted',
  'failed',
  'cancelled',
  'completed',
];

export interface StatusGroup {
  code: 'RUNNING' | 'QUEUED' | 'INTERRUPTED' | 'FAILED' | 'CANCELLED' | 'DONE';
  status: Session['taskStatus'];
  sessions: Session[];
}

export interface ProjectGroup {
  /** Absolute path used as the stable identity of the project bucket. */
  path: string;
  /** Human-friendly leaf name derived from the path. */
  name: string;
  /** True when this bucket matches the active workspace directory. */
  isActive: boolean;
  /** True when this project is explicitly registered as a workspace. */
  isBound: boolean;
  /** True when any session in the bucket is currently running. */
  hasRunning: boolean;
  /** Most recent activity timestamp across the bucket (ms since epoch). */
  lastActivity: number;
  sessions: Session[];
}

const STATUS_GROUP_CODE: Record<Session['taskStatus'], StatusGroup['code']> = {
  running: 'RUNNING',
  queued: 'QUEUED',
  interrupted: 'INTERRUPTED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  completed: 'DONE',
};

const normalizeProjectPath = (value: string): string =>
  value.length > 1 ? value.replace(/\/+$/, '') : value;

/** Deduplicate sessions by their ref key, preserving the first occurrence. */
export function dedupeSessions(sessions: Session[]): Session[] {
  const seen = new Map<string, Session>();
  for (const session of sessions) {
    if (!session) continue;
    const key = sessionRefKey(sessionRefFromSession(session));
    if (!seen.has(key)) seen.set(key, session);
  }
  return Array.from(seen.values());
}

/** Flat status buckets (the classic view). */
export function groupByStatus(sessions: Session[]): StatusGroup[] {
  const unique = dedupeSessions(sessions);
  const groups: StatusGroup[] = [];
  for (const status of TASK_STATUS_ORDER) {
    const matching = unique
      .filter((session) => session.taskStatus === status)
      .sort(compareTaskAttentionThenActivity);
    if (matching.length > 0) {
      groups.push({ code: STATUS_GROUP_CODE[status], status, sessions: matching });
    }
  }
  return groups;
}

/**
 * Project-first buckets. Registered projects keep registry order, while discovered
 * projects are ordered by recent activity. Selecting a project only changes focus
 * and must not implicitly pin or reorder it.
 */
export function groupByProject(
  sessions: Session[],
  activePath: string | null,
  boundProjectPaths: string[] = []
): ProjectGroup[] {
  const unique = dedupeSessions(sessions);
  const buckets = new Map<string, Session[]>();
  const normalizedBoundPaths = boundProjectPaths.map(normalizeProjectPath);
  const boundOrder = new Map(
    normalizedBoundPaths.map((projectPath, index) => [projectPath, index])
  );
  for (const projectPath of normalizedBoundPaths) {
    buckets.set(projectPath, []);
  }
  for (const session of unique) {
    const path = projectPathOf(session, activePath);
    const bucket = buckets.get(path);
    if (bucket) bucket.push(session);
    else buckets.set(path, [session]);
  }

  const normalizedActive = activePath ? normalizeProjectPath(activePath) : null;

  const groups: ProjectGroup[] = Array.from(buckets.entries()).map(
    ([path, bucketSessions]) => {
      const sorted = [...bucketSessions].sort(compareTaskAttentionThenActivity);
      const lastActivity = bucketSessions.reduce(
        (max, session) => Math.max(max, taskActivityTime(session)),
        0
      );
      return {
        path,
        name: projectNameOf(path),
        isActive: normalizedActive
          ? normalizeProjectPath(path) === normalizedActive
          : false,
        isBound: boundOrder.has(normalizeProjectPath(path)),
        hasRunning: bucketSessions.some((session) => session.taskStatus === 'running'),
        lastActivity,
        sessions: sorted,
      };
    }
  );

  groups.sort((a, b) => {
    if (a.isBound !== b.isBound) return a.isBound ? -1 : 1;
    if (a.isBound && b.isBound) {
      return (
        (boundOrder.get(normalizeProjectPath(a.path)) ?? Number.MAX_SAFE_INTEGER) -
        (boundOrder.get(normalizeProjectPath(b.path)) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return b.lastActivity - a.lastActivity;
  });

  return groups;
}
