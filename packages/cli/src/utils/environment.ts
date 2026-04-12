import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { basename, isAbsolute, resolve } from 'path';
import * as os from 'os';
import * as path from 'path';
import { setCwdState } from '../bootstrap/state.js';
import { getCwd } from './cwd.js';

export interface EnvironmentInfo {
  workingDirectory: string;
  projectRoot: string;
  platform: string;
  nodeVersion: string;
  currentDate: string;
  homeDirectory: string;
}

export interface EnvironmentContextOptions {
  includeGitSnapshot?: boolean;
}

export function getEnvironmentInfo(): EnvironmentInfo {
  const workingDir = getCwd();
  const projectRoot = findProjectRoot(workingDir);

  return {
    workingDirectory: workingDir,
    projectRoot,
    platform: `${os.platform()} (${os.arch()})`,
    nodeVersion: process.version,
    currentDate: new Date().toISOString().split('T')[0],
    homeDirectory: os.homedir(),
  };
}

function getGitCommandOutput(projectRoot: string, command: string): string | null {
  try {
    return execSync(command, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function getEnvironmentContext(
  options: EnvironmentContextOptions = {}
): string {
  const { includeGitSnapshot = false } = options;
  const env = getEnvironmentInfo();
  const isGitRepository = existsSync(path.join(env.projectRoot, '.git'));
  const shell = basename(process.env.SHELL || 'unknown');
  const keyFiles = ['package.json', 'tsconfig.json', 'BLADE.md', '.env.example']
    .filter((file) => existsSync(path.join(env.projectRoot, file)))
    .map((file) => `- \`${path.join(env.projectRoot, file)}\``);

  let context = `# Environment
You have been invoked in the following environment:
 - Primary working directory: ${env.workingDirectory}
  - Is a git repository: ${isGitRepository ? 'true' : 'false'}
 - Platform: ${env.platform}
 - Shell: ${shell}
 - Node.js: ${env.nodeVersion}`;

  if (includeGitSnapshot && isGitRepository) {
    const branch = getGitCommandOutput(env.projectRoot, 'git rev-parse --abbrev-ref HEAD');
    const status = getGitCommandOutput(env.projectRoot, 'git status --short');
    const recentCommits = getGitCommandOutput(
      env.projectRoot,
      'git log --oneline -n 3'
    );

    if (branch) {
      context += `\n - Current branch: ${branch}`;
    }

    if (status) {
      context += `\n\nWorking tree status:\n${status}`;
    }

    if (recentCommits) {
      context += `\n\nRecent commits:\n${recentCommits}`;
    }
  }

  context += `

When using file tools (read, write, edit), provide absolute paths based on: \`${env.workingDirectory}/\``;

  if (keyFiles.length > 0) {
    context += `\n\nKey project files at root for quick reference:\n${keyFiles.join('\n')}`;
  }

  return context;
}

/**
 * 向上遍历目录树查找项目根目录
 * 优先级：.git/.blade/.claude（仓库/工作区根）> package.json（兜底）
 */
export function findProjectRoot(startDir: string): string {
  let currentDir = startDir;
  let packageJsonCandidate: string | null = null;

  while (currentDir !== path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, '.blade'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, '.claude'))) {
      return currentDir;
    }
    if (!packageJsonCandidate && existsSync(path.join(currentDir, 'package.json'))) {
      packageJsonCandidate = currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return packageJsonCandidate ?? startDir;
}

/**
 * 设置全局 cwd 状态（解析符号链接）
 */
export function setCwd(newPath: string, relativeTo?: string): void {
  const resolved = isAbsolute(newPath)
    ? newPath
    : resolve(relativeTo || process.cwd(), newPath);
  let physicalPath: string;
  try {
    physicalPath = realpathSync(resolved);
  } catch {
    physicalPath = resolved;
  }
  setCwdState(physicalPath);
}

export function getDirectoryStructure(
  dir: string = getCwd(),
  maxDepth: number = 2
): string {
  try {
    const command = `find "${dir}" -maxdepth ${maxDepth} -type d -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -30`;
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    return output
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(dir, '.'))
      .join('\n');
  } catch {
    return '.';
  }
}
