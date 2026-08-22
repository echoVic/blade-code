import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LRUCache } from 'lru-cache';

export const MAX_CACHED_WORKSPACE_IDENTITIES = 512;

const identityCache = new LRUCache<string, WorkspaceIdentity>({
  max: MAX_CACHED_WORKSPACE_IDENTITIES,
});

export interface WorkspaceIdentity {
  projectPath: string;
  trustRoot: string;
}

async function findGitWorktreeRoot(projectPath: string): Promise<string | undefined> {
  let current = projectPath;
  while (true) {
    try {
      await fs.lstat(path.join(current, '.git'));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveCommonCheckoutRoot(
  worktreeRoot: string
): Promise<string | undefined> {
  const dotGit = path.join(worktreeRoot, '.git');
  const stat = await fs.lstat(dotGit);
  if (stat.isDirectory()) return worktreeRoot;
  if (!stat.isFile()) return undefined;

  const pointer = await fs.readFile(dotGit, 'utf8');
  const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
  if (!match) return undefined;
  const gitDir = await fs.realpath(
    path.isAbsolute(match[1]) ? match[1] : path.resolve(worktreeRoot, match[1])
  );
  let commonDir = gitDir;
  try {
    const relativeCommonDir = (
      await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')
    ).trim();
    if (relativeCommonDir) {
      commonDir = await fs.realpath(path.resolve(gitDir, relativeCommonDir));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path.basename(commonDir) === '.git'
    ? fs.realpath(path.dirname(commonDir))
    : undefined;
}

export async function resolveWorkspaceIdentity(
  projectDir: string
): Promise<WorkspaceIdentity> {
  if (!path.isAbsolute(projectDir)) {
    throw new Error('Workspace path must be absolute');
  }
  const projectPath = await fs.realpath(projectDir);
  const cached = identityCache.get(projectPath);
  if (cached) return cached;

  let trustRoot = projectPath;
  try {
    const worktreeRoot = await findGitWorktreeRoot(projectPath);
    if (worktreeRoot) {
      const sourceRoot = await resolveCommonCheckoutRoot(worktreeRoot);
      const relativeProject = path.relative(worktreeRoot, projectPath);
      if (
        sourceRoot &&
        (relativeProject === '' ||
          (!relativeProject.startsWith(`..${path.sep}`) &&
            relativeProject !== '..' &&
            !path.isAbsolute(relativeProject)))
      ) {
        const sourceProject = path.resolve(sourceRoot, relativeProject);
        trustRoot = await fs.realpath(sourceProject).catch(() => sourceProject);
      }
    }
  } catch {
    // Non-Git projects use their canonical directory as the trust root.
  }

  const identity = { projectPath, trustRoot };
  identityCache.set(projectPath, identity);
  return identity;
}

export async function invalidateWorkspaceIdentityCache(
  projectDir: string
): Promise<void> {
  if (!path.isAbsolute(projectDir)) {
    throw new Error('Workspace path must be absolute');
  }
  const projectPath = await fs.realpath(projectDir);
  identityCache.delete(projectPath);
}

export function resetWorkspaceIdentityCache(): void {
  identityCache.clear();
}
