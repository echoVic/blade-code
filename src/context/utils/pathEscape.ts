import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 路径转义工具 - 将项目路径转为目录名
 * 参考 Claude Code 的路径转义方式
 */

/**
 * 转义项目路径为目录名
 * 规则：将 / 替换为 -
 *
 * @example
 * escapeProjectPath('/Users/example/Documents/GitHub/Blade')
 * // 返回: '-Users-example-Documents-GitHub-Blade'
 */
export function escapeProjectPath(absPath: string): string {
  // 确保路径是绝对路径
  const normalized = path.resolve(absPath);
  // 将所有 / 替换为 -
  return normalized.replace(/\//g, '-');
}

/**
 * 反转义目录名为项目路径
 *
 * @example
 * unescapeProjectPath('-Users-example-Documents-GitHub-Blade')
 * // 返回: '/Users/example/Documents/GitHub/Blade'
 */
export function unescapeProjectPath(escapedPath: string): string {
  // 移除开头的 - 并替换所有 - 为 /
  if (escapedPath.startsWith('-')) {
    return '/' + escapedPath.slice(1).replace(/-/g, '/');
  }
  return escapedPath.replace(/-/g, '/');
}

/**
 * 获取项目的存储路径
 *
 * @param projectPath 项目绝对路径
 * @returns ~/.blade/projects/{escaped-path}/
 */
export function getProjectStoragePath(projectPath: string): string {
  const homeDir = os.homedir();
  const escaped = escapeProjectPath(projectPath);
  return path.join(homeDir, '.blade', 'projects', escaped);
}

/**
 * 获取项目的会话文件路径
 *
 * @param projectPath 项目绝对路径
 * @param sessionId 会话 ID
 * @returns ~/.blade/projects/{escaped-path}/{sessionId}.jsonl
 */
export function getSessionFilePath(projectPath: string, sessionId: string): string {
  return path.join(getProjectStoragePath(projectPath), `${sessionId}.jsonl`);
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
 * 获取 Blade 根存储目录
 * @returns ~/.blade/
 */
export function getBladeStorageRoot(): string {
  return path.join(os.homedir(), '.blade');
}

/**
 * 获取所有项目目录列表
 * @returns 项目目录名称数组
 */
export async function listProjectDirectories(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const projectsDir = path.join(getBladeStorageRoot(), 'projects');
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
