import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
  type AcpRemoteStateScope,
  isAcpRemoteWorkspaceDigest,
  listValidatedAcpRemoteStateScopes,
} from '../../acp/AcpRemoteWorkspace.js';
import { getBladeStorageRoot } from './BladeStorageRoot.js';

export { getBladeStorageRoot } from './BladeStorageRoot.js';

/**
 * 路径转义工具 - 将项目路径转为目录名
 */

/**
 * 转义项目路径为目录名
 * 规则：将 / 和 \ 替换为 -，将 : 替换为 _ (Windows 驱动器符号)
 *
 * @example
 * escapeProjectPath('/Users/john/projects/my-app')
 * // 返回: '-Users-john-projects-my-app'
 * escapeProjectPath('C:\\Users\\HP\\project')
 * // 返回: 'C_-Users-HP-project'
 */
function escapeProjectPath(absPath: string): string {
  // 确保路径是绝对路径
  const normalized = path.resolve(absPath);
  // 将所有 / 和 \ 替换为 -，将 : 替换为 _ (Windows 驱动器符号)
  return normalized.replace(/[/\\]/g, '-').replace(/:/g, '_');
}

/**
 * 反转义目录名为项目路径
 *
 * @example
 * unescapeProjectPath('-Users-john-projects-my-app')
 * // 返回: '/Users/john/projects/my-app'
 * unescapeProjectPath('C_-Users-HP-project')
 * // 返回: 'C:/Users/HP/project' (使用正斜杠，Node.js 在 Windows 上也支持)
 */
export function unescapeProjectPath(escapedPath: string): string {
  // 先将 _ 还原为 : (Windows 驱动器符号)
  let result = escapedPath.replace(/_/g, ':');

  // 如果以 - 开头（Unix 绝对路径），移除开头的 - 并添加 /
  if (result.startsWith('-')) {
    result = '/' + result.slice(1);
  }

  // 将所有 - 替换为 / (Node.js 在 Windows 上也支持正斜杠)
  return result.replace(/-/g, '/');
}

/**
 * 获取项目的存储路径
 *
 * @param projectPath 项目绝对路径
 * @returns ~/.blade/projects/{escaped-path}/
 */
export function getProjectStoragePath(projectPath: string): string {
  const escaped = escapeProjectPath(projectPath);
  return path.join(getBladeStorageRoot(), 'projects', escaped);
}

export function isAcpRemoteHostStateRoot(value: string): boolean {
  const storageRoot = path.resolve(getBladeStorageRoot());
  const resolved = path.resolve(value);
  const relative = path.relative(storageRoot, resolved);
  if (relative === '' || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return (
    segments.length === 2 &&
    segments[0] === 'acp-remote-workspaces' &&
    isAcpRemoteWorkspaceDigest(segments[1] ?? '')
  );
}

function resolveThroughExistingAncestor(value: string): string {
  let candidate = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(realpathSync.native(candidate), ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function normalizeLocalWorkspacePath(
  projectPath: string,
  label: 'projectPath' | 'directory' | 'cwd' | 'sourcePath' = 'projectPath'
): string {
  if (!path.isAbsolute(projectPath)) {
    throw new Error(`${label} must be absolute`);
  }
  const normalized = path.resolve(projectPath);
  const canonical = resolveThroughExistingAncestor(normalized);
  const remoteNamespace = path.join(
    resolveThroughExistingAncestor(getBladeStorageRoot()),
    'acp-remote-workspaces'
  );
  const relativeToRemoteNamespace = path.relative(remoteNamespace, canonical);
  const remoteRootSegment = relativeToRemoteNamespace.split(path.sep)[0];
  const isProtectedRemoteStatePath =
    relativeToRemoteNamespace === '' ||
    (relativeToRemoteNamespace !== '..' &&
      !path.isAbsolute(relativeToRemoteNamespace) &&
      !relativeToRemoteNamespace.startsWith(`..${path.sep}`) &&
      remoteRootSegment !== undefined &&
      /^[a-f0-9]{64}$/i.test(remoteRootSegment));
  if (isProtectedRemoteStatePath) {
    throw new Error(`${label} must reference a local workspace`);
  }
  return normalized;
}

export function getSessionStoragePath(projectPath: string): string {
  return getProjectStoragePath(projectPath);
}

export function getAcpRemoteSessionStoragePath(scope: AcpRemoteStateScope): string {
  return String(scope);
}

export function isValidSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === 'string' &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(sessionId)
  );
}

export function assertValidSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

/**
 * 获取项目的会话文件路径
 *
 * @param projectPath 项目绝对路径
 * @param sessionId 会话 ID
 * @returns ~/.blade/projects/{escaped-path}/{sessionId}.jsonl
 */
export function getSessionFilePath(projectPath: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  return path.join(getSessionStoragePath(projectPath), `${sessionId}.jsonl`);
}

export function getAcpRemoteSessionFilePath(
  scope: AcpRemoteStateScope,
  sessionId: string
): string {
  assertValidSessionId(sessionId);
  return path.join(getAcpRemoteSessionStoragePath(scope), `${sessionId}.jsonl`);
}

export function getSessionInboxFilePath(
  projectPath: string,
  sessionId: string
): string {
  assertValidSessionId(sessionId);
  return path.join(getSessionStoragePath(projectPath), `${sessionId}.inbox.json`);
}

export function getAcpRemoteSessionInboxFilePath(
  scope: AcpRemoteStateScope,
  sessionId: string
): string {
  assertValidSessionId(sessionId);
  return path.join(getAcpRemoteSessionStoragePath(scope), `${sessionId}.inbox.json`);
}

export function getSessionGoalFilePath(projectPath: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  return path.join(getSessionStoragePath(projectPath), `${sessionId}.goal.json`);
}

export function getAcpRemoteSessionGoalFilePath(
  scope: AcpRemoteStateScope,
  sessionId: string
): string {
  assertValidSessionId(sessionId);
  return path.join(getAcpRemoteSessionStoragePath(scope), `${sessionId}.goal.json`);
}

export function getAcpRemoteSessionLeaseFilePath(
  scope: AcpRemoteStateScope,
  sessionId: string
): string {
  assertValidSessionId(sessionId);
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(
    getAcpRemoteSessionStoragePath(scope),
    `.session-lease-${digest}.lock`
  );
}

/**
 * 检测当前项目的 Git 分支
 * @param projectPath 项目路径
 * @returns Git 分支名称，如果不是 Git 仓库则返回 undefined
 */
export function detectGitBranch(projectPath: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 获取所有项目目录列表
 * @returns 项目目录名称数组
 */
export async function listProjectDirectories(): Promise<string[]> {
  try {
    const projectsDir = path.join(getBladeStorageRoot(), 'projects');
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function listSessionStorageScopes(): Promise<
  Array<{ storagePath: string; projectPath: string; kind: 'local' | 'acp-remote' }>
> {
  const storageRoot = path.resolve(getBladeStorageRoot());
  const localScopes = await listProjectDirectories()
    .then((directories) =>
      directories.flatMap((directory) => {
        try {
          return [
            {
              storagePath: path.join(storageRoot, 'projects', directory),
              projectPath: normalizeLocalWorkspacePath(unescapeProjectPath(directory)),
              kind: 'local' as const,
            },
          ];
        } catch {
          return [];
        }
      })
    )
    .catch(() => []);

  const remoteScopes = await listValidatedAcpRemoteStateScopes().then((scopes) =>
    scopes.map((scope) => ({
      storagePath: String(scope),
      projectPath: String(scope),
      kind: 'acp-remote' as const,
    }))
  );

  return [...localScopes, ...remoteScopes];
}
