import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

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
 * 获取子代理会话文件路径
 * 子代理 JSONL 文件与主会话存储在同一目录下
 *
 * @param projectPath 项目绝对路径
 * @param agentId 子代理 ID (格式: agent_<uuid>)
 * @returns ~/.blade/projects/{escaped-path}/{agentId}.jsonl
 */
export function getSubagentFilePath(projectPath: string, agentId: string): string {
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getProjectStoragePath(projectPath), `${safeId}.jsonl`);
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
