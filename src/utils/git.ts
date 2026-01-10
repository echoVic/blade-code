/**
 * Git 工具函数集
 *
 * 提供完整的 Git 操作支持，包括：
 * - 验证函数：检测 Git 安装、仓库状态
 * - 查询函数：分支、提交、状态查询
 * - 操作函数：暂存、提交
 * - Diff 函数：获取差异，带大小限制
 *
 */

import { type ExecFileException, execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// Internal Helpers
// ============================================================================

interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 执行 Git 命令（不抛出异常）
 */
async function gitExec(cwd: string, args: string[]): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' }, // 10MB buffer
      (error: ExecFileException | null, stdout, stderr) => {
        const code =
          error == null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({
          code,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      }
    );
  });
}

/**
 * 执行 Git 命令并返回布尔值
 */
async function gitCheck(cwd: string, args: string[]): Promise<boolean> {
  const { code } = await gitExec(cwd, args);
  return code === 0;
}

/**
 * 执行 Git 命令并返回输出字符串
 */
async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitExec(cwd, args);
  return stdout.trim();
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * 检查 Git 是否已安装
 */
async function _isGitInstalled(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查目录是否在 Git 仓库中
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  return gitCheck(cwd, ['rev-parse', '--is-inside-work-tree']);
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * 检查是否有未提交的更改
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const output = await gitOutput(cwd, ['status', '--porcelain']);
  return output.length > 0;
}

/**
 * 获取当前分支名
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  return gitOutput(cwd, ['branch', '--show-current']);
}

/**
 * 获取最近的提交信息
 */
export async function getRecentCommitMessages(
  cwd: string,
  count = 10
): Promise<string> {
  return gitOutput(cwd, ['log', '-n', String(count), '--pretty=format:%s']);
}

// ============================================================================
// Action Functions
// ============================================================================

/**
 * 暂存所有更改
 */
export async function stageAll(cwd: string): Promise<void> {
  const { code, stderr } = await gitExec(cwd, ['add', '.']);
  if (code !== 0) {
    const errorMessage = stderr || 'Unknown error';
    if (errorMessage.includes('fatal: pathspec')) {
      throw new Error('Failed to stage files: Invalid file path or pattern');
    }
    throw new Error(`Failed to stage files: ${errorMessage}`);
  }
}

/**
 * 提交暂存的更改
 * @param cwd - 工作目录
 * @param message - 提交信息
 * @param skipHooks - 是否跳过 hooks
 * @param onOutput - 输出回调（用于流式显示）
 */
export async function gitCommit(
  cwd: string,
  message: string,
  skipHooks = false,
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<void> {
  const args = ['commit', '-m', message];
  if (skipHooks) {
    args.push('--no-verify');
  }

  // 如果没有输出回调，使用简单执行
  if (!onOutput) {
    const { code, stderr } = await gitExec(cwd, args);
    if (code !== 0) {
      throw new Error(stderr || 'Commit failed');
    }
    return;
  }

  // 使用 spawn 进行流式输出
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', args, { cwd });
    let stderr = '';

    const processOutput = (
      data: Buffer,
      stream: 'stdout' | 'stderr',
      buffer: string
    ): string => {
      const text = buffer + data.toString();
      const lines = text.split('\n');
      const incomplete = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          onOutput(line, stream);
        }
      }
      return incomplete;
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';

    gitProcess.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer = processOutput(data, 'stdout', stdoutBuffer);
    });

    gitProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      stderrBuffer = processOutput(data, 'stderr', stderrBuffer);
    });

    gitProcess.on('error', (error) => {
      reject(error);
    });

    gitProcess.on('close', (code) => {
      // 刷新剩余的缓冲内容
      if (stdoutBuffer.trim()) {
        onOutput(stdoutBuffer, 'stdout');
      }
      if (stderrBuffer.trim()) {
        onOutput(stderrBuffer, 'stderr');
      }

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || 'Commit failed'));
      }
    });
  });
}

// ============================================================================
// Composite Functions
// ============================================================================

export interface GitStatus {
  branch: string;
  mainBranch: string;
  status: string;
  log: string;
  author: string;
  authorLog: string;
}

/**
 * 获取完整的 Git 状态信息
 */
export async function getGitStatus(opts: { cwd: string }): Promise<GitStatus | null> {
  const { cwd } = opts;
  if (!(await isGitRepository(cwd))) {
    return null;
  }

  const [branch, mainBranch, status, log, author] = await Promise.all([
    gitOutput(cwd, ['branch', '--show-current']),
    gitOutput(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
      .then((s) => s.replace('origin/', ''))
      .catch(() => 'main'),
    gitOutput(cwd, ['status', '--short']),
    gitOutput(cwd, ['log', '--oneline', '-n', '5']),
    gitOutput(cwd, ['config', 'user.email']),
  ]);

  const authorLog = author
    ? await gitOutput(cwd, ['log', '--author', author, '--oneline', '-n', '5'])
    : '';

  return {
    branch,
    mainBranch,
    status,
    log,
    author,
    authorLog,
  };
}

/**
 * 将 Git 状态格式化为 LLM 友好的字符串
 */
export function getLlmGitStatus(status: GitStatus | null): string | null {
  if (!status) {
    return null;
  }
  return `
Git repository status (snapshot at conversation start):
Current branch: ${status.branch}
Main branch (target for PRs): ${status.mainBranch}

Status:
${status.status || '(clean)'}

Recent commits:
${status.log || '(no commits)'}

Your recent commits:
${status.authorLog || '(no recent commits)'}
  `.trim();
}

// ============================================================================
// Diff Functions
// ============================================================================

/**
 * 获取暂存文件列表（带状态）
 */
export async function getStagedFileList(cwd: string): Promise<string> {
  return gitOutput(cwd, ['diff', '--cached', '--name-status']);
}

/**
 * 获取暂存区的 diff
 * - 排除锁文件和大文件
 * - 限制大小为 100KB
 */
export async function getStagedDiff(cwd: string): Promise<string> {
  // 排除锁文件和常见大文件类型
  const excludePatterns = [
    ':!pnpm-lock.yaml',
    ':!package-lock.json',
    ':!yarn.lock',
    ':!*.min.js',
    ':!*.bundle.js',
    ':!dist/**',
    ':!build/**',
    ':!*.gz',
    ':!*.zip',
    ':!*.tar',
    ':!*.tgz',
    ':!*.woff',
    ':!*.woff2',
    ':!*.ttf',
    ':!*.png',
    ':!*.jpg',
    ':!*.jpeg',
    ':!*.gif',
    ':!*.ico',
    ':!*.svg',
    ':!*.pdf',
  ];

  const args = ['diff', '--cached', '--', ...excludePatterns];
  const { code, stdout: diff, stderr } = await gitExec(cwd, args);

  if (code !== 0) {
    const errorMessage = stderr || 'Unknown error';
    if (errorMessage.includes('bad revision')) {
      throw new Error(
        'Failed to get staged diff: Invalid Git revision or corrupt repository'
      );
    }
    if (errorMessage.includes('fatal: not a git repository')) {
      throw new Error('Not a Git repository');
    }
    throw new Error(`Failed to get staged diff: ${errorMessage}`);
  }

  // 限制 diff 大小 - 100KB
  const MAX_DIFF_SIZE = 100 * 1024;

  if (diff.length > MAX_DIFF_SIZE) {
    const truncatedDiff = diff.substring(0, MAX_DIFF_SIZE);
    return (
      truncatedDiff +
      '\n\n[Diff truncated due to size. Total diff size: ' +
      (diff.length / 1024).toFixed(2) +
      'KB]'
    );
  }
  return diff;
}
