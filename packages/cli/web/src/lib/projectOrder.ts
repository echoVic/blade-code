export const PROJECT_ORDER_STORAGE_KEY = 'blade.sidebar.project-order.v1';

function uniquePaths(values: unknown[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

export function readProjectOrder(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]'
    );
    return Array.isArray(value) ? uniquePaths(value) : [];
  } catch {
    return [];
  }
}

export function persistProjectOrder(paths: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PROJECT_ORDER_STORAGE_KEY,
      JSON.stringify(uniquePaths(paths))
    );
  } catch {
    // Ordering is a best-effort client preference.
  }
}

export function applyProjectOrder<T extends { path: string }>(
  projects: T[],
  preferredPaths: string[]
): T[] {
  const preferredIndex = new Map(
    uniquePaths(preferredPaths).map((path, index) => [path, index])
  );
  const fallbackOffset = preferredIndex.size;
  return projects
    .map((project, index) => ({
      project,
      rank: preferredIndex.get(project.path) ?? fallbackOffset + index,
    }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ project }) => project);
}

export function moveProjectPath(
  paths: string[],
  sourcePath: string,
  targetPath: string
): string[] {
  const next = uniquePaths(paths);
  const sourceIndex = next.indexOf(sourcePath);
  const targetIndex = next.indexOf(targetPath);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export function moveProjectPathBy(
  paths: string[],
  projectPath: string,
  offset: -1 | 1
): string[] {
  const next = uniquePaths(paths);
  const sourceIndex = next.indexOf(projectPath);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= next.length) return next;
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex]!, next[sourceIndex]!];
  return next;
}
