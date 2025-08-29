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
 * Git Status 工具 (基于 ConfirmableToolBase)
 * 查看Git仓库的当前状态
 */
class GitStatusTool extends ConfirmableToolBase {
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
      default: true, // 默认跳过确认，因为是只读操作
    },
  };

  /**
   * 构建 Git status 命令
   */
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

  /**
   * 获取确认选项 - 只读操作默认跳过确认
   */
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true, // 只读操作，默认跳过确认
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 10000,
    };
  }

  /**
   * 预检查命令
   */
  protected async preCheckCommand(
    _command: string,
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
    const { porcelain, short } = params;

    if (porcelain) {
      return '获取Git状态（机器可读格式）';
    } else if (short) {
      return '获取Git状态（简短格式）';
    } else {
      return '获取Git状态（标准格式）';
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
    const lines = output.split('\n').filter(line => line.trim());

    const processedResult: any = {
      rawOutput: output,
    };

    if (params.porcelain || params.short) {
      // 解析简短格式
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
      // 标准格式输出
      processedResult.output = output;

      // 简单解析状态信息
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

// 导出工具实例
export const gitStatus = new GitStatusTool();
