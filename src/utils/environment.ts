import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export interface EnvironmentInfo {
  workingDirectory: string;
  projectRoot: string;
  platform: string;
  nodeVersion: string;
  currentDate: string;
  homeDirectory: string;
}

export function getEnvironmentInfo(): EnvironmentInfo {
  const workingDir = process.cwd();
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
- ✅ Correct: \`${env.workingDirectory}/package.json\`
- ✅ Correct: \`${env.workingDirectory}/src/index.ts\`
- ❌ Incorrect: \`/package.json\` (root directory)
- ❌ Incorrect: \`package.json\` (relative path without context)

**Always use** \`${env.workingDirectory}/\` as the base for file paths.`;
}

function findProjectRoot(startDir: string): string {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return startDir;
}

function existsSync(filePath: string): boolean {
  try {
    execSync(`test -e "${filePath}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getDirectoryStructure(
  dir: string = process.cwd(),
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
