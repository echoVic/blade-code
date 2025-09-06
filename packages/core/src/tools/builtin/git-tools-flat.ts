import { exec } from 'child_process';
import { promisify } from 'util';
import { ErrorFactory, globalErrorMonitor } from '../../error/index.js';
import {
  CommandPreCheckResult,
  ConfirmableToolBase,
  ConfirmationOptions,
  RiskLevel,
} from '../base/ConfirmableToolBase.js';

const execAsync = promisify(exec);

/**
 * Git Status 工具
 */
export class GitStatusTool extends ConfirmableToolBase {
  readonly name = 'git_status';
  readonly description = '查看Git仓库的当前状态';
  readonly category = 'git';
  readonly tags = ['git', 'status', 'repository'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    porcelain: {
      type: 'boolean' as const,
      required: false,
      description: '使用机器可读的格式',
      default: false,
    },
    short: {
      type: 'boolean' as const,
      required: false,
      description: '显示简短格式',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { porcelain, short } = params;
    let command = 'git status';

    if (porcelain) {
      command += ' --porcelain';
    } else if (short) {
      command += ' --short';
    }

    return command;
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true,
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 10000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    workingDirectory: string,
    _params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: workingDirectory });
      return { valid: true };
    } catch (error: any) {
      if (error.message.includes('not a git repository')) {
        return {
          valid: false,
          message: '当前目录不是 Git 仓库',
          suggestions: [
            {
              command: 'git init',
              description: '初始化 Git 仓库',
              riskLevel: RiskLevel.SAFE,
            },
          ],
        };
      }

      const gitError = ErrorFactory.createNotFoundError('Git仓库', workingDirectory, {
        context: { workingDirectory, error: error.message },
        retryable: false,
        suggestions: ['检查当前目录是否为Git仓库', '运行git init初始化仓库', '确认Git已正确安装'],
      });

      globalErrorMonitor.monitor(gitError);

      return {
        valid: false,
        message: `Git 预检查失败: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    const { porcelain, short } = params;

    if (porcelain) {
      return '获取Git状态（机器可读格式）';
    } else if (short) {
      return '获取Git状态（简短格式）';
    } else {
      return '获取Git状态（标准格式）';
    }
  }

  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const output = result.stdout.trim();
    const lines = output.split('\n').filter(line => line.trim());

    const processedResult: any = {
      rawOutput: output,
    };

    if (params.porcelain || params.short) {
      const files = lines.map(line => {
        const status = line.substring(0, 2);
        const filename = line.substring(3);
        return {
          status,
          filename,
          staged: status[0] !== ' ' && status[0] !== '?',
          modified: status[1] !== ' ',
          untracked: status === '??',
        };
      });

      processedResult.files = files;
      processedResult.summary = {
        total: files.length,
        staged: files.filter(f => f.staged).length,
        modified: files.filter(f => f.modified).length,
        untracked: files.filter(f => f.untracked).length,
      };
    } else {
      processedResult.output = output;
      const hasChanges =
        output.includes('Changes to be committed') ||
        output.includes('Changes not staged') ||
        output.includes('Untracked files');

      processedResult.hasChanges = hasChanges;
      processedResult.isClean = output.includes('nothing to commit, working tree clean');
    }

    return processedResult;
  }
}

/**
 * Git Diff 工具
 */
export class GitDiffTool extends ConfirmableToolBase {
  readonly name = 'git_diff';
  readonly description = '查看Git文件差异';
  readonly category = 'git';
  readonly tags = ['git', 'diff', 'changes', 'comparison'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    file: {
      type: 'string' as const,
      required: false,
      description: '指定文件路径',
      default: '',
    },
    staged: {
      type: 'boolean' as const,
      required: false,
      description: '查看暂存区的差异',
      default: false,
    },
    nameOnly: {
      type: 'boolean' as const,
      required: false,
      description: '只显示文件名',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { file, staged, nameOnly } = params;
    let command = 'git diff';

    if (staged) {
      command += ' --cached';
    }

    if (nameOnly) {
      command += ' --name-only';
    }

    if (file) {
      command += ` "${file}"`;
    }

    return command;
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true,
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 15000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    workingDirectory: string,
    _params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: workingDirectory });
      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `Git 预检查失败: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    const { file, staged, nameOnly } = params;

    let desc = '查看Git差异';
    if (staged) desc += '（暂存区）';
    if (nameOnly) desc += '（仅文件名）';
    if (file) desc += `（文件: ${file}）`;

    return desc;
  }

  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const output = result.stdout.trim();

    const processedResult: any = {
      rawOutput: output,
    };

    if (params.nameOnly) {
      const files = output.split('\n').filter(line => line.trim());
      processedResult.files = files;
      processedResult.count = files.length;
    } else {
      processedResult.diff = output;
      processedResult.hasChanges = output.length > 0;
    }

    return processedResult;
  }
}

/**
 * Git Log 工具
 */
export class GitLogTool extends ConfirmableToolBase {
  readonly name = 'git_log';
  readonly description = '查看Git提交历史';
  readonly category = 'git';
  readonly tags = ['git', 'log', 'history', 'commits'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    count: {
      type: 'number' as const,
      required: false,
      description: '显示的提交数量',
      default: 10,
    },
    oneline: {
      type: 'boolean' as const,
      required: false,
      description: '单行格式显示',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { count, oneline } = params;
    let command = 'git log';

    if (oneline) {
      command += ' --oneline';
    }

    command += ` -n ${count}`;

    return command;
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true,
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 10000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    workingDirectory: string,
    _params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: workingDirectory });
      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `Git 预检查失败: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    const { count, oneline } = params;
    return `查看最近${count}个提交${oneline ? '（单行格式）' : ''}`;
  }

  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    _params: Record<string, any>
  ): Promise<any> {
    const output = result.stdout.trim();

    const processedResult: any = {
      rawOutput: output,
      commits: [],
    };

    const lines = output.split('\n').filter(line => line.trim());
    processedResult.commitCount = lines.length;
    processedResult.commits = lines;

    return processedResult;
  }
}

// 统一导出所有Git工具
export const GIT_TOOLS = [GitStatusTool, GitDiffTool, GitLogTool];

// 导出工具实例
export const gitStatus = new GitStatusTool();
export const gitDiff = new GitDiffTool();
export const gitLog = new GitLogTool();
