import { exec } from 'child_process';
import { promisify } from 'util';
import { ConfirmableToolBase, RiskLevel } from '../../base/ConfirmableToolBase.js';

const execAsync = promisify(exec);

/**
 * Git Smart Commit 工具
 * 使用LLM智能分析变更内容并生成提交信息
 */
export class GitSmartCommitTool extends ConfirmableToolBase {
  readonly name = 'git_smart_commit';
  readonly description = '智能分析Git变更内容，使用LLM生成合适的提交信息并执行提交';
  readonly category = 'git';
  readonly version = '1.0.0';
  readonly author = 'Agent CLI';
  readonly tags = ['git', 'commit', 'smart', 'llm', 'auto'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    autoAdd: {
      type: 'boolean' as const,
      required: false,
      description: '是否自动添加所有修改的文件到暂存区',
      default: true,
    },
    dryRun: {
      type: 'boolean' as const,
      required: false,
      description: '干运行，只分析并生成提交信息，不实际提交',
      default: false,
    },
    llmAnalysis: {
      type: 'string' as const,
      required: false,
      description: 'LLM分析的变更内容（由Agent自动填充）',
      default: '',
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认（仅在自动化场景下使用）',
      default: false,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { llmAnalysis } = params;

    if (!llmAnalysis) {
      throw new Error('需要LLM分析结果来生成提交信息');
    }

    // 返回最终的commit命令
    const commitMessage = llmAnalysis.trim();
    return `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`;
  }

  protected getConfirmationOptions(params: Record<string, any>) {
    const { dryRun, autoAdd } = params;

    return {
      skipConfirmation: params.skipConfirmation || dryRun,
      riskLevel: autoAdd ? RiskLevel.MODERATE : RiskLevel.SAFE,
      confirmMessage: dryRun ? '是否预览提交信息？' : '是否执行智能提交？',
      showPreview: true,
    };
  }

  protected async preCheckCommand(
    command: string,
    workingDirectory: string,
    params: Record<string, any>
  ) {
    const { autoAdd, llmAnalysis } = params;

    try {
      // 1. 检查是否是Git仓库
      await execAsync('git rev-parse --git-dir', { cwd: workingDirectory });
    } catch {
      return {
        valid: false,
        message: '当前目录不是Git仓库',
        suggestions: [
          {
            command: 'git init',
            description: '初始化Git仓库',
            riskLevel: RiskLevel.MODERATE,
          },
        ],
      };
    }

    // 2. 检查是否有LLM分析结果
    if (!llmAnalysis) {
      return {
        valid: false,
        message: '缺少LLM分析结果，无法生成提交信息',
      };
    }

    // 3. 检查是否有变更
    const { stdout: statusOutput } = await execAsync('git status --porcelain', {
      cwd: workingDirectory,
    });

    if (!statusOutput.trim() && !autoAdd) {
      return {
        valid: false,
        message: '没有变更需要提交',
        suggestions: [
          {
            command: 'git status',
            description: '查看仓库状态',
            riskLevel: RiskLevel.SAFE,
          },
        ],
      };
    }

    return { valid: true };
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    const { autoAdd, dryRun, llmAnalysis } = params;

    if (dryRun) {
      return `预览模式 - 生成提交信息: "${llmAnalysis}"`;
    }

    return autoAdd ? `自动添加文件并提交: "${llmAnalysis}"` : `提交暂存区变更: "${llmAnalysis}"`;
  }

  protected async getExecutionPreview(
    command: string,
    workingDirectory: string,
    params: Record<string, any>
  ): Promise<string> {
    const { autoAdd } = params;

    try {
      // 如果需要自动添加，先执行 git add
      if (autoAdd) {
        const { stdout: statusOutput } = await execAsync('git status --porcelain', {
          cwd: workingDirectory,
        });

        if (statusOutput.trim()) {
          await execAsync('git add -A', { cwd: workingDirectory });
        }
      }

      // 获取暂存区文件列表
      const { stdout: diffNameOnly } = await execAsync('git diff --cached --name-only', {
        cwd: workingDirectory,
      });

      const { stdout: diffStat } = await execAsync('git diff --cached --stat', {
        cwd: workingDirectory,
      });

      const changedFiles = diffNameOnly
        .trim()
        .split('\n')
        .filter(f => f.trim());

      if (changedFiles.length === 0) {
        return '暂存区没有变更文件';
      }

      return `将要提交的文件:\n${changedFiles.map(f => `  - ${f}`).join('\n')}\n\n变更统计:\n${diffStat}`;
    } catch (error) {
      return `预览信息获取失败: ${(error as Error).message}`;
    }
  }

  protected async executeCommand(
    command: string,
    workingDirectory: string,
    options: any,
    params: Record<string, any>
  ) {
    const { autoAdd, dryRun, llmAnalysis } = params;

    try {
      // 如果需要自动添加文件
      if (autoAdd && !dryRun) {
        const { stdout: statusOutput } = await execAsync('git status --porcelain', {
          cwd: workingDirectory,
        });

        if (statusOutput.trim()) {
          await execAsync('git add -A', { cwd: workingDirectory });
          console.log('📦 已自动添加所有变更文件到暂存区');
        }
      }

      // 获取变更信息用于返回
      const { stdout: diffNameOnly } = await execAsync('git diff --cached --name-only', {
        cwd: workingDirectory,
      });

      const { stdout: diffStat } = await execAsync('git diff --cached --stat', {
        cwd: workingDirectory,
      });

      const changedFiles = diffNameOnly
        .trim()
        .split('\n')
        .filter(f => f.trim());

      // 如果是干运行模式
      if (dryRun) {
        return {
          success: true,
          command,
          workingDirectory,
          data: {
            commitMessage: llmAnalysis,
            changedFiles,
            diffStat: diffStat.trim(),
            previewMode: true,
            wouldCommit: true,
          },
        };
      }

      // 检查暂存区是否有变更
      if (changedFiles.length === 0) {
        return {
          success: false,
          error: '暂存区没有变更，请先使用git add添加文件',
        };
      }

      // 执行实际的commit命令
      const result = await super.executeCommand(command, workingDirectory, options, params);

      if (result.success) {
        // 解析提交结果
        const output = result.stdout || '';
        const lines = output.split('\n');

        let commitHash = '';
        let commitSummary = '';

        for (const line of lines) {
          if (line.includes('[') && line.includes(']')) {
            const match = line.match(/\[([^\]]+)\]\s*(.+)/);
            if (match) {
              commitHash = match[1];
              commitSummary = match[2];
            }
          }
        }

        // 提取文件统计
        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        const statsLine = lines.find(
          line => line.includes('file') && (line.includes('insertion') || line.includes('deletion'))
        );

        if (statsLine) {
          const fileMatch = statsLine.match(/(\d+)\s+file/);
          if (fileMatch) filesChanged = parseInt(fileMatch[1]);

          const insertMatch = statsLine.match(/(\d+)\s+insertion/);
          if (insertMatch) insertions = parseInt(insertMatch[1]);

          const deleteMatch = statsLine.match(/(\d+)\s+deletion/);
          if (deleteMatch) deletions = parseInt(deleteMatch[1]);
        }

        result.data = {
          commitMessage: llmAnalysis,
          commitHash,
          commitSummary,
          changedFiles,
          statistics: {
            filesChanged,
            insertions,
            deletions,
          },
          smartGenerated: true,
          rawOutput: output,
        };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Git smart commit failed: ${(error as Error).message}`,
        command,
        workingDirectory,
      };
    }
  }
}

// 导出工具实例
export const gitSmartCommit = new GitSmartCommitTool();
