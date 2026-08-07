import type { Session } from '@/services';

const MANAGED_WORKTREE_MARKER = '/.blade/worktrees/';
const MANAGED_PROJECT_HASH = /-[a-f0-9]{8,}$/i;
const TEMP_PROJECT_SUFFIX = /^(.+?(?:test|config))-[a-z0-9]{6,}$/i;

function managedWorktreeProject(projectPath: string): string | null {
  const markerIndex = projectPath.indexOf(MANAGED_WORKTREE_MARKER);
  if (markerIndex < 0) return null;
  const projectSegment = projectPath
    .slice(markerIndex + MANAGED_WORKTREE_MARKER.length)
    .split('/')[0];
  if (!projectSegment) return null;
  return `${projectPath.slice(
    0,
    markerIndex + MANAGED_WORKTREE_MARKER.length
  )}${projectSegment}`;
}

function temporaryProjectRoot(projectPath: string): string | null {
  if (!projectPath.includes('/tmp/') && !projectPath.includes('/T/')) return null;
  const parts = projectPath.split('/');
  const leaf = parts.at(-1);
  const match = leaf?.match(TEMP_PROJECT_SUFFIX);
  if (!match?.[1]) return null;
  parts[parts.length - 1] = match[1];
  return parts.join('/');
}

export function projectNameOf(projectPath: string): string {
  const leaf = projectPath.split('/').filter(Boolean).at(-1) || projectPath;
  return projectPath.includes(MANAGED_WORKTREE_MARKER)
    ? leaf.replace(MANAGED_PROJECT_HASH, '')
    : leaf;
}

export function projectPathOf(
  session: Session,
  activePath: string | null = null
): string {
  const sourcePath = session.taskSourceProjectPath;
  const temporaryProject = temporaryProjectRoot(sourcePath || session.projectPath);
  if (temporaryProject) return temporaryProject;
  if (sourcePath) return sourcePath;

  const managedProject = managedWorktreeProject(session.projectPath);
  if (!managedProject) return session.projectPath;

  const managedName = projectNameOf(managedProject);
  if (activePath && managedName === projectNameOf(activePath)) return activePath;
  return managedProject;
}

export function sessionsForProject(
  sessions: Session[],
  projectPath: string | null,
  activePath: string | null = null
): Session[] {
  if (!projectPath) return sessions;
  return sessions.filter(
    (session) => projectPathOf(session, activePath) === projectPath
  );
}
