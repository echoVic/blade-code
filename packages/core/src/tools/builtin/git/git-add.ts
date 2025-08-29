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
 * Git Add 工具 (基于 ConfirmableToolBase)
 * 添加文件到暂存区，带用户确认功能
 */
class GitAddTool extends ConfirmableToolBase {
  readonly name = 'git_add';
  readonly description = '添加文件到Git暂存区（需要用户确认）';
  readonly category = 'git';
  readonly tags = ['git', 'add', 'stage', 'index'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    files: {
      type: 'string' as const,
      required: false,
      description: '要添加的文件路径，支持通配符，用空格分隔多个文件',
      default: '',
    },
    all: {
      type: 'boolean' as const,
      required: false,
      description: '添加所有修改的文件',
      default: false,
    },
    update: {
      type: 'boolean' as const,
      required: false,
      description: '只添加已跟踪的文件',
      default: false,
    },
    dryRun: {
      type: 'boolean' as const,
      required: false,
      description: '干运行，只显示将要添加的文件',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: false,
    },
    riskLevel: {
      type: 'string' as const,
      required: false,
      description: '风险级别：safe, moderate, high, critical',
      default: 'safe',
    },
  };

  /**
   * 预处理参数
   */
  protected async preprocessParameters(params: Record<string, any>): Promise<Record<string, any>> {
    const { files } = params;

    // 验证文件路径安全性
    if (files) {
      const fileList = files.split(/\s+/).filter((f: string) => f.trim());
      for (const file of fileList) {
        if (file.includes('..') || file.startsWith('/')) {
          throw new Error(`不安全的文件路径: ${file}`);
        }
      }

      if (fileList.length === 0) {
        throw new Error('没有指定有效的文件路径');
      }
    }

    return params;
  }

  /**
   * 构建 Git add 命令
   */
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { files, all, update, dryRun } = params;

    let command = 'git add';

    // 添加选项
    if (dryRun) {
      command += ' --dry-run';
    }

    if (all) {
      command += ' -A';
    } else if (update) {
      command += ' -u';
    } else if (files) {
      const fileList = files.split(/\s+/).filter((f: string) => f.trim());
      command += ` ${fileList.join(' ')}`;
    } else {
      // 默认添加当前目录下所有文件
      command += ' .';
    }

    return command;
  }

  /**
   * 获取确认选项
   */
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    const baseOptions = super.getConfirmationOptions(params);

    // Git add 操作通常比较安全
    return {
      ...baseOptions,
      riskLevel: RiskLevel.SAFE,
      confirmMessage: params.dryRun ? '执行干运行预览要添加的文件？' : '是否添加这些文件到暂存区？',
    };
  }

  /**
   * 预检查命令
   */
  protected async preCheckCommand(
    command: string,
    workingDirectory: string,
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
    const { files, all, update, dryRun } = params;

    let description = '';

    if (dryRun) {
      description += '预览要添加的文件';
    } else if (all) {
      description += '添加所有修改的文件';
    } else if (update) {
      description += '添加所有已跟踪的文件';
    } else if (files) {
      description += `添加指定文件: ${files}`;
    } else {
      description += '添加当前目录下所有文件';
    }

    return description;
  }

  /**
   * 获取执行预览
   */
  protected async getExecutionPreview(
    command: string,
    workingDirectory: string,
    _params: Record<string, any>
  ): Promise<string> {
    try {
      // 显示当前未暂存的文件
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: workingDirectory,
        timeout: 5000,
      });

      if (!statusOutput.trim()) {
        return '没有需要添加的文件';
      }

      let preview = '待添加的文件:\n';
      const lines = statusOutput.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);

        // 只显示未暂存的文件
        if (status[1] !== ' ') {
          let statusText = '';
          if (status[1] === 'M') statusText = '修改';
          else if (status.includes('?')) statusText = '新文件';
          else if (status[1] === 'D') statusText = '删除';
          else statusText = '其他';

          preview += `  ${statusText}: ${file}\n`;
        }
      }

      return preview || '没有未暂存的文件需要添加';
    } catch (error) {
      return '无法获取预览信息';
    }
  }

  /**
   * 后处理结果
   */
  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const output = result.stdout.trim();

    if (params.dryRun) {
      // 解析干运行结果
      const lines = output.split('\n').filter(line => line.trim());
      const wouldAdd = lines.map(line => line.replace(/^add\s+/, ''));

      return {
        type: 'dry-run',
        wouldAdd,
        fileCount: wouldAdd.length,
        message: `将要添加 ${wouldAdd.length} 个文件到暂存区`,
        rawOutput: output,
      };
    }

    // 实际添加操作 - 获取当前暂存区状态
    try {
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: params.path || '.',
        timeout: 5000,
      });

      const statusLines = statusOutput.split('\n').filter(line => line.trim());
      const stagedFiles = statusLines
        .filter(line => line[0] !== ' ' && line[0] !== '?')
        .map(line => line.substring(3));

      return {
        type: 'add',
        stagedFiles,
        stagedCount: stagedFiles.length,
        message: output || `成功添加文件到暂存区`,
        rawOutput: output,
      };
    } catch (statusError) {
      return {
        type: 'add',
        message: output || '文件已添加到暂存区',
        rawOutput: output,
      };
    }
  }
}

// 导出工具实例
export const gitAdd = new GitAddTool();
