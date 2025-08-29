import { exec } from 'child_process';
import { promisify } from 'util';
import {
  CommandPreCheckResult,
  ConfirmableToolBase,
  ConfirmationOptions,
  RiskLevel,
} from '../../base/ConfirmableToolBase.js';

const execAsync = promisify(exec);

/**
 * Git Diff 工具 (基于 ConfirmableToolBase)
 * 查看Git文件差异
 */
class GitDiffTool extends ConfirmableToolBase {
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
    cached: {
      type: 'boolean' as const,
      required: false,
      description: '查看已暂存文件的差异（同staged）',
      default: false,
    },
    nameOnly: {
      type: 'boolean' as const,
      required: false,
      description: '只显示文件名',
      default: false,
    },
    stat: {
      type: 'boolean' as const,
      required: false,
      description: '显示统计信息',
      default: false,
    },
    commit1: {
      type: 'string' as const,
      required: false,
      description: '第一个提交hash/分支名',
      default: '',
    },
    commit2: {
      type: 'string' as const,
      required: false,
      description: '第二个提交hash/分支名',
      default: '',
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true, // 默认跳过确认，因为是只读操作
    },
  };

  /**
   * 构建 Git diff 命令
   */
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { file, staged, cached, nameOnly, stat, commit1, commit2 } = params;

    let command = 'git diff';

    // 添加差异类型选项
    if (staged || cached) {
      command += ' --staged';
    }

    // 添加输出格式选项
    if (nameOnly) {
      command += ' --name-only';
    } else if (stat) {
      command += ' --stat';
    }

    // 添加提交比较
    if (commit1 && commit2) {
      command += ` ${commit1}..${commit2}`;
    } else if (commit1) {
      command += ` ${commit1}`;
    }

    // 添加文件路径
    if (file) {
      command += ` -- ${file}`;
    }

    return command;
  }

  /**
   * 获取确认选项 - 只读操作默认跳过确认
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true, // 只读操作，默认跳过确认
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 15000,
    };
  }

  /**
   * 预检查命令
   */
  protected async preCheckCommand(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    workingDirectory: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      // 检查是否在 Git 仓库中
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

      return {
        valid: false,
        message: `Git 预检查失败: ${error.message}`,
      };
    }
  }

  /**
   * 获取执行描述
   */
  protected getExecutionDescription(params: Record<string, any>): string {
    const { file, staged, cached, commit1, commit2 } = params;

    let description = '查看Git差异';

    if (file) {
      description += ` - 文件: ${file}`;
    }

    if (staged || cached) {
      description += ' (暂存区)';
    }

    if (commit1 && commit2) {
      description += ` (${commit1}..${commit2})`;
    } else if (commit1) {
      description += ` (与 ${commit1} 比较)`;
    }

    return description;
  }

  /**
   * 后处理结果
   */
  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const output = result.stdout.trim();

    const processedResult: any = {
      rawOutput: output,
    };

    if (output) {
      if (params.nameOnly) {
        // 解析文件名列表
        processedResult.files = output.split('\n').filter(line => line.trim());
        processedResult.fileCount = processedResult.files.length;
        processedResult.type = 'nameOnly';
      } else if (params.stat) {
        // 解析统计信息
        const lines = output.split('\n');
        const files = [];
        let insertions = 0;
        let deletions = 0;

        for (const line of lines) {
          if (line.includes('|')) {
            const parts = line.trim().split('|');
            if (parts.length >= 2) {
              const filename = parts[0].trim();
              const changes = parts[1].trim();
              files.push({ filename, changes });
            }
          } else if (line.includes('insertion') || line.includes('deletion')) {
            const insertionMatch = line.match(/(\d+) insertion/);
            if (insertionMatch) insertions = parseInt(insertionMatch[1]);
            const deletionMatch = line.match(/(\d+) deletion/);
            if (deletionMatch) deletions = parseInt(deletionMatch[1]);
          }
        }

        processedResult.type = 'stat';
        processedResult.files = files;
        processedResult.summary = {
          fileCount: files.length,
          insertions,
          deletions,
          totalChanges: insertions + deletions,
        };
      } else {
        // 标准diff格式
        processedResult.type = 'diff';
        processedResult.diff = output;

        // 简单统计
        const lines = output.split('\n');
        const addedLines = lines.filter(line => line.startsWith('+')).length;
        const deletedLines = lines.filter(line => line.startsWith('-')).length;
        const modifiedFiles = new Set();

        lines.forEach(line => {
          if (line.startsWith('diff --git')) {
            const match = line.match(/diff --git a\/(.+) b\/(.+)/);
            if (match) {
              modifiedFiles.add(match[1]);
            }
          }
        });

        processedResult.summary = {
          modifiedFiles: Array.from(modifiedFiles),
          fileCount: modifiedFiles.size,
          addedLines,
          deletedLines,
        };
      }

      processedResult.hasChanges = true;
    } else {
      processedResult.type = 'empty';
      processedResult.message = '没有发现差异';
      processedResult.hasChanges = false;
    }

    return processedResult;
  }
}

// 导出工具实例
export const gitDiff = new GitDiffTool();
