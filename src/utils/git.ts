/**
 * Git 工具函数集
 *
 * 提供完整的 Git 操作支持，包括：
 * - 验证函数：检测 Git 安装、仓库状态
 * - 查询函数：分支、提交、状态查询
 * - 操作函数：暂存、提交、推送
 * - Diff 函数：获取差异，带大小限制
 * - 克隆函数：完整克隆支持，带进度解析
 *
 */

import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
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
      { cwd, maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error as any).code || 1 : 0,
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
export async function isGitInstalled(): Promise<boolean> {
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

/**
 * 检查 Git 用户名和邮箱是否已配置
 */
export async function isGitUserConfigured(
  cwd: string
): Promise<{ name: boolean; email: boolean }> {
  const [nameResult, emailResult] = await Promise.all([
    gitCheck(cwd, ['config', 'user.name']),
    gitCheck(cwd, ['config', 'user.email']),
  ]);
  return { name: nameResult, email: emailResult };
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
 * 检查是否配置了远程仓库
 */
export async function hasRemote(cwd: string): Promise<boolean> {
  const output = await gitOutput(cwd, ['remote']);
  return output.length > 0;
}

/**
 * 检查分支是否存在
 */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  return gitCheck(cwd, ['rev-parse', '--verify', branchName]);
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

/**
 * 获取远程仓库 URL
 */
export async function getGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const output = await gitOutput(cwd, ['config', '--get', 'remote.origin.url']);
    return output || null;
  } catch {
    return null;
  }
}

/**
 * 获取默认分支（main/master）
 */
export async function getDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const output = await gitOutput(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    return output.replace('origin/', '') || null;
  } catch {
    return null;
  }
}

/**
 * 获取与远程的同步状态
 */
export async function getGitSyncStatus(
  cwd: string
): Promise<'synced' | 'ahead' | 'behind' | 'diverged' | 'unknown'> {
  try {
    // 先 fetch 获取最新信息
    await gitExec(cwd, ['fetch', 'origin', '--quiet']);

    // 获取当前分支
    const currentBranch = await getCurrentBranch(cwd);
    if (!currentBranch) return 'unknown';

    // 检查远程跟踪分支是否存在
    const trackingExists = await gitCheck(cwd, [
      'rev-parse',
      '--verify',
      `origin/${currentBranch}`,
    ]);
    if (!trackingExists) return 'unknown';

    // 获取 ahead/behind 数量
    const { stdout: counts } = await gitExec(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      `origin/${currentBranch}...HEAD`,
    ]);

    const [behind, ahead] = counts.trim().split('\t').map(Number);

    if (ahead === 0 && behind === 0) return 'synced';
    if (ahead > 0 && behind === 0) return 'ahead';
    if (ahead === 0 && behind > 0) return 'behind';
    return 'diverged';
  } catch {
    return 'unknown';
  }
}

/**
 * 获取当前 commit hash
 */
export async function getCurrentCommit(cwd: string): Promise<string> {
  try {
    return await gitOutput(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return '';
  }
}

/**
 * 获取待提交的文件列表
 */
export async function getPendingChanges(cwd: string): Promise<string[]> {
  try {
    const output = await gitOutput(cwd, ['status', '--porcelain']);
    if (!output) return [];
    return output.split('\n').map((line) => line.substring(3).trim());
  } catch {
    return [];
  }
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

/**
 * 推送到远程
 * @param cwd - 工作目录
 * @param onOutput - 输出回调（用于流式显示进度）
 */
export async function gitPush(
  cwd: string,
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<void> {
  // 如果没有输出回调，使用简单执行
  if (!onOutput) {
    const { code, stderr } = await gitExec(cwd, ['push']);
    if (code !== 0) {
      throw new Error(stderr || 'Push failed');
    }
    return;
  }

  // 使用 spawn 进行流式输出
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['push', '--progress'], { cwd });
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
        // 处理 \r 进度更新，只取最后一段
        const segments = line.split('\r');
        const finalSegment = segments[segments.length - 1];
        if (finalSegment.trim()) {
          onOutput(finalSegment, stream);
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
        const segments = stdoutBuffer.split('\r');
        const finalSegment = segments[segments.length - 1];
        if (finalSegment.trim()) {
          onOutput(finalSegment, 'stdout');
        }
      }
      if (stderrBuffer.trim()) {
        const segments = stderrBuffer.split('\r');
        const finalSegment = segments[segments.length - 1];
        if (finalSegment.trim()) {
          onOutput(finalSegment, 'stderr');
        }
      }

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || 'Push failed'));
      }
    });
  });
}

/**
 * 创建并切换到新分支
 */
export async function createAndCheckoutBranch(
  cwd: string,
  branchName: string
): Promise<void> {
  const { code, stderr } = await gitExec(cwd, ['checkout', '-b', branchName]);
  if (code !== 0) {
    throw new Error(stderr || 'Failed to create branch');
  }
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

// ============================================================================
// URL Validation and Security
// ============================================================================

/**
 * Git URL 验证模式
 */
const GIT_HTTPS_PATTERN =
  /^https?:\/\/(?:[a-zA-Z0-9_.~-]+@)?[a-zA-Z0-9_.~-]+(?:\.[a-zA-Z0-9_.~-]+)*(?::\d+)?\/[a-zA-Z0-9_.~/-]+(\.git)?$/;
const GIT_SSH_PATTERN =
  /^git@[a-zA-Z0-9_.~-]+(?:\.[a-zA-Z0-9_.~-]+)*:[a-zA-Z0-9_.~/-]+(\.git)?$/;

/**
 * 验证 Git URL 格式
 */
export function validateGitUrl(url: string): boolean {
  return GIT_HTTPS_PATTERN.test(url) || GIT_SSH_PATTERN.test(url);
}

/**
 * 清理 Git URL 以防止命令注入
 */
export function sanitizeGitUrl(url: string): string {
  return url
    .split(/[;&|`$()]/)[0] // 移除 shell 特殊字符
    .trim();
}

/**
 * 验证目标路径安全性
 */
export function validateDestinationPath(destination: string): {
  valid: boolean;
  error?: string;
} {
  const normalizedDest = resolve(destination);
  const dangerousPaths = [
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/System',
    'C:\\Windows',
    'C:\\Program Files',
  ];

  if (dangerousPaths.some((p) => normalizedDest.startsWith(p))) {
    return {
      valid: false,
      error: 'Cannot clone to system directories',
    };
  }

  return { valid: true };
}

/**
 * 从 Git URL 提取仓库名
 */
export function extractRepoName(url: string): string {
  const repoNameMatch = url.match(/\/([^/]+?)(\.git)?$/);
  return repoNameMatch ? repoNameMatch[1] : `repo-${Date.now()}`;
}

// ============================================================================
// Clone Functions
// ============================================================================

/**
 * Git 克隆进度信息
 */
export interface GitCloneProgress {
  percent: number;
  message: string;
}

/**
 * Git 克隆进度解析器
 * 支持中英文输出
 */
export class GitCloneProgressParser {
  private currentStage = '';
  private stageProgress = { receiving: 0, resolving: 0, checking: 0 };
  private lastOverallPercent = 0;

  parse(output: string): GitCloneProgress | null {
    // 支持中英文 Git 输出
    const progressMatch = output.match(/(\d+)%/);
    if (!progressMatch) {
      return null;
    }

    const percent = Number.parseInt(progressMatch[1], 10);

    // 检测当前阶段并更新进度
    if (output.includes('Receiving objects') || output.includes('接收对象中')) {
      this.currentStage = 'receiving';
      this.stageProgress.receiving = percent;
    } else if (
      output.includes('Resolving deltas') ||
      output.includes('处理 delta 中')
    ) {
      if (this.stageProgress.receiving === 0) {
        this.stageProgress.receiving = 100;
      }
      if (this.currentStage !== 'resolving') {
        this.lastOverallPercent = 0;
      }
      this.currentStage = 'resolving';
      this.stageProgress.resolving = percent;
    } else if (output.includes('Checking out files') || output.includes('检出文件中')) {
      if (this.stageProgress.receiving === 0) {
        this.stageProgress.receiving = 100;
      }
      if (this.stageProgress.resolving === 0) {
        this.stageProgress.resolving = 100;
      }
      if (this.currentStage !== 'checking') {
        this.lastOverallPercent = 0;
      }
      this.currentStage = 'checking';
      this.stageProgress.checking = percent;
    } else {
      return null;
    }

    // 计算总体进度 (0-100%)
    let overallPercent = 0;

    const hasResolving =
      this.stageProgress.resolving > 0 || this.currentStage === 'resolving';
    const hasChecking =
      this.stageProgress.checking > 0 || this.currentStage === 'checking';

    if (hasResolving && hasChecking) {
      // 三个阶段: Receiving(0-70%), Resolving(70-90%), Checking(90-100%)
      overallPercent =
        Math.floor((this.stageProgress.receiving * 70) / 100) +
        Math.floor((this.stageProgress.resolving * 20) / 100) +
        Math.floor((this.stageProgress.checking * 10) / 100);
    } else if (hasResolving) {
      // 两个阶段: Receiving(0-80%), Resolving(80-100%)
      overallPercent =
        Math.floor((this.stageProgress.receiving * 80) / 100) +
        Math.floor((this.stageProgress.resolving * 20) / 100);
    } else {
      // 单个阶段（小仓库）: Receiving(0-100%)
      overallPercent = this.stageProgress.receiving;
    }

    // 确保进度只增不减（单调递增）
    overallPercent = Math.max(overallPercent, this.lastOverallPercent);
    this.lastOverallPercent = overallPercent;

    return {
      percent: overallPercent,
      message: output.trim(),
    };
  }
}

/**
 * 克隆仓库选项
 */
export interface CloneRepositoryOptions {
  url: string;
  destination: string;
  onProgress?: (progress: GitCloneProgress) => void;
  signal?: AbortSignal;
  timeoutMinutes?: number;
}

/**
 * 克隆仓库结果
 */
export interface CloneRepositoryResult {
  success: boolean;
  clonePath?: string;
  repoName?: string;
  error?: string;
  errorCode?:
    | 'CANCELLED'
    | 'SSH_AUTH_FAILED'
    | 'AUTH_REQUIRED'
    | 'NETWORK_ERROR'
    | 'REPO_NOT_FOUND'
    | 'TIMEOUT'
    | 'GIT_NOT_INSTALLED'
    | 'INVALID_URL'
    | 'DIR_EXISTS'
    | 'UNKNOWN';
  needsCredentials?: boolean;
}

/**
 * 克隆 Git 仓库
 */
export async function cloneRepository(
  options: CloneRepositoryOptions
): Promise<CloneRepositoryResult> {
  let clonePath = '';

  try {
    // 验证输入
    if (!options.url || !options.destination) {
      return {
        success: false,
        error: 'Git URL and destination are required',
      };
    }

    // 清理 Git URL
    const sanitizedUrl = sanitizeGitUrl(options.url);

    // 检查 Git 是否可用
    if (!(await isGitInstalled())) {
      return {
        success: false,
        error:
          'Git is not installed or not available in PATH. Please install Git and try again.',
        errorCode: 'GIT_NOT_INSTALLED',
      };
    }

    // 验证 URL 格式
    if (!validateGitUrl(sanitizedUrl)) {
      return {
        success: false,
        error: 'Invalid Git repository URL format. Please use HTTPS or SSH format.',
        errorCode: 'INVALID_URL',
      };
    }

    // 确保目标目录存在
    if (!existsSync(options.destination)) {
      mkdirSync(options.destination, { recursive: true });
    }

    // 验证目标路径安全性
    const destValidation = validateDestinationPath(options.destination);
    if (!destValidation.valid) {
      return {
        success: false,
        error: destValidation.error,
      };
    }

    // 提取仓库名并构建克隆路径
    const repoName = extractRepoName(sanitizedUrl);
    clonePath = join(options.destination, repoName);

    // 检查目录是否已存在
    if (existsSync(clonePath)) {
      return {
        success: false,
        error: `Directory '${repoName}' already exists at destination`,
        errorCode: 'DIR_EXISTS',
      };
    }

    // 克隆仓库
    let gitProcess: ReturnType<typeof spawn> | null = null;
    let isCancelled = false;
    const progressParser = new GitCloneProgressParser();

    const clonePromise = new Promise<void>((resolvePromise, reject) => {
      const env: Record<string, string> = {
        ...process.env,
        GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new',
      } as Record<string, string>;

      gitProcess = spawn('git', ['clone', '--progress', sanitizedUrl, clonePath], {
        env,
      });
      let stderr = '';

      // 设置中止处理
      if (options.signal) {
        const abortHandler = async () => {
          isCancelled = true;
          if (gitProcess && !gitProcess.killed) {
            gitProcess.stdout?.removeAllListeners();
            gitProcess.stderr?.removeAllListeners();
            gitProcess.removeAllListeners();
            gitProcess.kill('SIGTERM');

            await new Promise<void>((resolve) => {
              const forceKillTimeout = setTimeout(() => {
                if (gitProcess && !gitProcess.killed) {
                  gitProcess.kill('SIGKILL');
                }
                resolve();
              }, 1000);

              if (gitProcess) {
                gitProcess.once('exit', () => {
                  clearTimeout(forceKillTimeout);
                  resolve();
                });
              } else {
                clearTimeout(forceKillTimeout);
                resolve();
              }
            });
          }
          reject(new Error('Clone operation cancelled by user'));
        };

        options.signal.addEventListener('abort', abortHandler);
      }

      // 从 stderr 解析进度
      gitProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderr += output;

        if (options.onProgress) {
          const progress = progressParser.parse(output);
          if (progress) {
            options.onProgress(progress);
          }
        }
      });

      gitProcess.on('error', (error) => {
        reject(error);
      });

      gitProcess.on('close', (code) => {
        if (isCancelled) return;

        if (code === 0) {
          if (options.onProgress) {
            options.onProgress({
              percent: 100,
              message: 'Clone completed',
            });
          }
          resolvePromise();
        } else {
          reject(new Error(stderr || `Git clone exited with code ${code}`));
        }
      });
    });

    // 添加超时
    const timeoutMinutes = options.timeoutMinutes || 30;
    const CLONE_TIMEOUT = timeoutMinutes * 60 * 1000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(async () => {
        if (gitProcess) {
          gitProcess.stdout?.removeAllListeners();
          gitProcess.stderr?.removeAllListeners();
          gitProcess.removeAllListeners();
          gitProcess.kill('SIGTERM');

          await new Promise<void>((resolve) => {
            const forceKillTimeout = setTimeout(() => {
              if (gitProcess && !gitProcess.killed) {
                gitProcess.kill('SIGKILL');
              }
              resolve();
            }, 1000);

            if (gitProcess) {
              gitProcess.once('exit', () => {
                clearTimeout(forceKillTimeout);
                resolve();
              });
            } else {
              clearTimeout(forceKillTimeout);
              resolve();
            }
          });
        }
        reject(
          new Error(
            'Clone operation timed out. The repository might be too large or the connection is slow.'
          )
        );
      }, CLONE_TIMEOUT);
    });

    try {
      await Promise.race([clonePromise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    return {
      success: true,
      clonePath,
      repoName,
    };
  } catch (error: unknown) {
    // 清理不完整的克隆目录
    if (clonePath && existsSync(clonePath)) {
      try {
        rmSync(clonePath, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    }

    // 处理常见的 git clone 错误
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // SSH 相关错误
    if (
      errorMessage.includes('Host key verification failed') ||
      errorMessage.includes('Permission denied (publickey)')
    ) {
      return {
        success: false,
        error:
          'SSH authentication failed. Please ensure your SSH keys are properly configured.',
        errorCode: 'SSH_AUTH_FAILED',
      };
    }

    // HTTPS 认证错误
    if (
      errorMessage.includes('Authentication failed') ||
      errorMessage.includes('could not read Username') ||
      errorMessage.includes('could not read Password')
    ) {
      return {
        success: false,
        error: 'Authentication required. Please provide username and password.',
        errorCode: 'AUTH_REQUIRED',
        needsCredentials: true,
      };
    }

    if (errorMessage.includes('Could not resolve hostname')) {
      return {
        success: false,
        error:
          'Could not resolve hostname. Please check your internet connection and the repository URL.',
        errorCode: 'NETWORK_ERROR',
      };
    }

    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return {
        success: false,
        error: 'Repository not found or access denied',
        errorCode: 'REPO_NOT_FOUND',
      };
    }

    // 超时错误
    if (errorMessage.includes('timed out')) {
      return {
        success: false,
        error:
          'Clone operation timed out. The repository might be too large or the connection is slow.',
        errorCode: 'TIMEOUT',
      };
    }

    // 用户取消
    if (errorMessage.includes('cancelled by user')) {
      return {
        success: false,
        error: 'Clone operation cancelled by user',
        errorCode: 'CANCELLED',
      };
    }

    return {
      success: false,
      error: 'Failed to clone repository. Please check the URL and try again.',
      errorCode: 'UNKNOWN',
    };
  }
}
