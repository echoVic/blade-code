import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, resolve } from 'path';
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

export function getEnvironmentContext(): string {
  const env = getEnvironmentInfo();

  return `# Environment Context

## Working Directory
**Current**: \`${env.workingDirectory}\`
**Project Root**: \`${env.projectRoot}\`

## System Information
- **Platform**: ${env.platform}
- **Node.js**: ${env.nodeVersion}
- **Date**: ${env.currentDate}

## File Path Guidelines
When using file tools (read, write, edit), provide **absolute paths**:
- Correct: \`${env.workingDirectory}/package.json\`
- Correct: \`${env.workingDirectory}/src/index.ts\`
- Incorrect: \`/package.json\` (root directory)
- Incorrect: \`package.json\` (relative path without context)

**Always use** \`${env.workingDirectory}/\` as the base for file paths.`;
}

/**
 * 向上遍历目录树查找项目根目录
 * 识别标记（按优先级）：.git、package.json、.blade/、.claude/
 */
export function findProjectRoot(startDir: string): string {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    // Blade / Claude 配置目录也是项目根标记
    if (existsSync(path.join(currentDir, '.blade'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, '.claude'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return startDir;
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
