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
 * Git Branch 工具 (基于 ConfirmableToolBase)
 * 管理Git分支，带用户确认功能
 */
class GitBranchTool extends ConfirmableToolBase {
  readonly name = 'git_branch';
  readonly description = '管理Git分支（需要用户确认）';
  readonly category = 'git';
  readonly tags = ['git', 'branch', 'checkout', 'switch'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    action: {
      type: 'string' as const,
      required: false,
      description: '操作类型: list(列出), create(创建), delete(删除), switch(切换)',
      default: 'list',
    },
    branchName: {
      type: 'string' as const,
      required: false,
      description: '分支名称',
      default: '',
    },
    remote: {
      type: 'boolean' as const,
      required: false,
      description: '包含远程分支',
      default: false,
    },
    all: {
      type: 'boolean' as const,
      required: false,
      description: '显示所有分支（本地和远程）',
      default: false,
    },
    createFrom: {
      type: 'string' as const,
      required: false,
      description: '从指定分支创建新分支',
      default: '',
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
      default: 'moderate',
    },
  };

  /**
   * 预处理参数
   */
  protected async preprocessParameters(params: Record<string, any>): Promise<Record<string, any>> {
    const { action, branchName } = params;

    // 验证操作类型
    const validActions = ['list', 'create', 'delete', 'switch', 'checkout'];
    if (!validActions.includes(action.toLowerCase())) {
      throw new Error(`不支持的操作: ${action}`);
    }

    // 验证分支名称
    if (['create', 'delete', 'switch', 'checkout'].includes(action.toLowerCase()) && !branchName) {
      throw new Error(`${action}操作需要指定分支名称`);
    }

    return params;
  }

  /**
   * 构建 Git branch 命令
   */
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { action, branchName, remote, all, createFrom } = params;

    let command = '';

    switch (action.toLowerCase()) {
      case 'list':
        command = 'git branch';
        if (all) {
          command += ' -a';
        } else if (remote) {
          command += ' -r';
        }
        break;

      case 'create':
        command = `git branch ${branchName}`;
        if (createFrom) {
          command += ` ${createFrom}`;
        }
        break;

      case 'delete':
        command = `git branch -d ${branchName}`;
        break;

      case 'switch':
      case 'checkout':
        command = `git checkout ${branchName}`;
        break;

      default:
        throw new Error(`不支持的操作: ${action}`);
    }

    return command;
  }

  /**
   * 获取确认选项 - 根据操作类型设置不同的风险级别
   */
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    const baseOptions = super.getConfirmationOptions(params);

    let riskLevel = RiskLevel.SAFE;
    let skipConfirmation = false;
    let confirmMessage = '';

    switch (params.action.toLowerCase()) {
      case 'list':
        // 列出分支是只读操作，默认跳过确认
        riskLevel = RiskLevel.SAFE;
        skipConfirmation = true;
        confirmMessage = '查看分支列表？';
        break;

      case 'create':
        riskLevel = RiskLevel.SAFE;
        confirmMessage = `创建新分支 "${params.branchName}"？`;
        break;

      case 'switch':
      case 'checkout':
        riskLevel = RiskLevel.MODERATE;
        confirmMessage = `切换到分支 "${params.branchName}"？`;
        break;

      case 'delete':
        riskLevel = RiskLevel.HIGH;
        confirmMessage = `⚠️  删除分支 "${params.branchName}"？此操作不可撤销！`;
        break;

      default:
        riskLevel = RiskLevel.MODERATE;
        confirmMessage = '执行Git分支操作？';
    }

    return {
      ...baseOptions,
      riskLevel,
      skipConfirmation: skipConfirmation || baseOptions.skipConfirmation,
      confirmMessage,
    };
  }

  /**
   * 预检查命令
   */
  protected async preCheckCommand(
    _command: string,
    workingDirectory: string,
    params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      // 检查是否在 Git 仓库中
      await execAsync('git rev-parse --git-dir', { cwd: workingDirectory });

      // 对于切换分支操作，检查分支是否存在
      if (['switch', 'checkout'].includes(params.action.toLowerCase())) {
        try {
          const { stdout } = await execAsync('git branch -a', { cwd: workingDirectory });
          const branches = stdout.split('\n').map(line => line.trim().replace(/^\*?\s*/, ''));
          const branchExists = branches.some(
            branch => branch === params.branchName || branch.includes(`/${params.branchName}`)
          );

          if (!branchExists) {
            return {
              valid: false,
              message: `分支 "${params.branchName}" 不存在`,
              suggestions: [
                {
                  command: await this.buildCommand({ ...params, action: 'create' }),
                  description: `创建新分支 "${params.branchName}"`,
                  riskLevel: RiskLevel.SAFE,
                },
              ],
            };
          }
        } catch (error) {
          // 忽略分支检查错误，让Git命令自己处理
        }
      }

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
    const { action, branchName, createFrom } = params;

    switch (action.toLowerCase()) {
      case 'list':
        return '查看Git分支列表';
      case 'create':
        return `创建新分支: ${branchName}${createFrom ? ` (从 ${createFrom})` : ''}`;
      case 'delete':
        return `删除分支: ${branchName}`;
      case 'switch':
      case 'checkout':
        return `切换到分支: ${branchName}`;
      default:
        return `Git分支操作: ${action}`;
    }
  }

  /**
   * 获取执行预览
   */
  protected async getExecutionPreview(
    _command: string,
    workingDirectory: string,
    params: Record<string, any>
  ): Promise<string> {
    if (params.action.toLowerCase() === 'list') {
      return '将显示分支列表';
    }

    try {
      // 显示当前分支状态
      const { stdout } = await execAsync('git branch', { cwd: workingDirectory });
      const currentBranch = stdout
        .split('\n')
        .find(line => line.startsWith('*'))
        ?.trim()
        .substring(2);

      let preview = `当前分支: ${currentBranch || '未知'}\n`;

      switch (params.action.toLowerCase()) {
        case 'create':
          preview += `将创建新分支: ${params.branchName}`;
          break;
        case 'delete':
          preview += `⚠️  将删除分支: ${params.branchName}`;
          break;
        case 'switch':
        case 'checkout':
          preview += `将切换到分支: ${params.branchName}`;
          break;
      }

      return preview;
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

    if (params.action === 'list') {
      // 解析分支列表
      const lines = output.split('\n').filter(line => line.trim());
      const branches = lines.map(line => {
        const trimmed = line.trim();
        const isCurrent = trimmed.startsWith('*');
        const isRemote = trimmed.includes('remotes/');

        let name = trimmed.replace(/^\*?\s*/, '');
        if (isRemote) {
          name = name.replace('remotes/', '');
        }

        return {
          name,
          isCurrent,
          isRemote,
          fullName: trimmed.replace(/^\*?\s*/, ''),
        };
      });

      return {
        type: 'list',
        branches,
        currentBranch: branches.find(b => b.isCurrent)?.name || '',
        totalBranches: branches.length,
        localBranches: branches.filter(b => !b.isRemote).length,
        remoteBranches: branches.filter(b => b.isRemote).length,
        rawOutput: output,
      };
    } else {
      // 其他操作的结果
      const processedResult: any = {
        type: params.action,
        message: output || result.stderr,
        rawOutput: output,
      };

      if (params.action === 'create') {
        processedResult.createdBranch = params.branchName;
      } else if (params.action === 'delete') {
        processedResult.deletedBranch = params.branchName;
      } else if (params.action === 'switch' || params.action === 'checkout') {
        processedResult.switchedTo = params.branchName;
      }

      return processedResult;
    }
  }
}

// 导出工具实例
export const gitBranch = new GitBranchTool();
