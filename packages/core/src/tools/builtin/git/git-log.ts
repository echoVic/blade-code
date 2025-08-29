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
 * Git Log 工具 (基于 ConfirmableToolBase)
 * 查看Git提交历史
 */
class GitLogTool extends ConfirmableToolBase {
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
    limit: {
      type: 'number' as const,
      required: false,
      description: '显示的提交数量限制',
      default: 10,
    },
    oneline: {
      type: 'boolean' as const,
      required: false,
      description: '每个提交显示一行',
      default: false,
    },
    graph: {
      type: 'boolean' as const,
      required: false,
      description: '显示分支图形',
      default: false,
    },
    author: {
      type: 'string' as const,
      required: false,
      description: '按作者过滤提交',
      default: '',
    },
    since: {
      type: 'string' as const,
      required: false,
      description: '显示指定日期之后的提交 (如: "2023-01-01", "1 week ago")',
      default: '',
    },
    until: {
      type: 'string' as const,
      required: false,
      description: '显示指定日期之前的提交',
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
   * 构建 Git log 命令
   */
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { limit, oneline, graph, author, since, until } = params;

    let command = 'git log';

    // 添加限制
    if (limit > 0) {
      command += ` -${limit}`;
    }

    // 添加格式选项
    if (oneline) {
      command += ' --oneline';
    } else {
      command += ' --pretty=format:"%h|%an|%ae|%ad|%s" --date=iso';
    }

    // 添加图形显示
    if (graph) {
      command += ' --graph';
    }

    // 添加作者过滤
    if (author) {
      command += ` --author="${author}"`;
    }

    // 添加日期过滤
    if (since) {
      command += ` --since="${since}"`;
    }

    if (until) {
      command += ` --until="${until}"`;
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
    const { limit, author, since, until, oneline, graph } = params;

    let description = `查看Git提交历史 (最多${limit}条)`;

    if (author) {
      description += ` - 作者: ${author}`;
    }

    if (since) {
      description += ` - 从: ${since}`;
    }

    if (until) {
      description += ` - 到: ${until}`;
    }

    if (oneline) {
      description += ' (简洁模式)';
    }

    if (graph) {
      description += ' (图形模式)';
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
      const lines = output.split('\n');

      if (params.oneline) {
        // 解析 oneline 格式
        processedResult.type = 'oneline';
        processedResult.commits = lines.map(line => {
          const spaceIndex = line.indexOf(' ');
          return {
            hash: line.substring(0, spaceIndex),
            message: line.substring(spaceIndex + 1),
          };
        });
      } else if (!params.graph) {
        // 解析自定义格式 (不带graph)
        processedResult.type = 'detailed';
        processedResult.commits = lines.map(line => {
          const parts = line.split('|');
          return {
            hash: parts[0],
            author: parts[1],
            email: parts[2],
            date: parts[3],
            message: parts[4],
          };
        });
      } else {
        // 带graph的格式保持原样
        processedResult.type = 'graph';
        processedResult.output = output;
      }

      processedResult.totalCommits = lines.length;
    } else {
      processedResult.type = 'empty';
      processedResult.commits = [];
      processedResult.totalCommits = 0;
      processedResult.message = '没有找到提交记录';
    }

    return processedResult;
  }
}

// 导出工具实例
export const gitLog = new GitLogTool();
