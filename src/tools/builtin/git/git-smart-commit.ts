import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../../types.js';

const execAsync = promisify(exec);

/**
 * Git Smart Commit 工具
 * 使用LLM智能分析变更内容并生成提交信息
 */
export const gitSmartCommit: ToolDefinition = {
  name: 'git_smart_commit',
  description: '智能分析Git变更内容，使用LLM生成合适的提交信息并执行提交',
  category: 'git',
  version: '1.0.0',
  author: 'Agent CLI',
  tags: ['git', 'commit', 'smart', 'llm', 'auto'],

  parameters: {
    path: {
      type: 'string',
      required: false,
      description: '仓库路径，默认为当前目录',
      default: '.',
    },
    autoAdd: {
      type: 'boolean',
      required: false,
      description: '是否自动添加所有修改的文件到暂存区',
      default: true,
    },
    dryRun: {
      type: 'boolean',
      required: false,
      description: '干运行，只分析并生成提交信息，不实际提交',
      default: false,
    },
    llmAnalysis: {
      type: 'string',
      required: false,
      description: 'LLM分析的变更内容（由Agent自动填充）',
      default: '',
    },
  },

  async execute(parameters: Record<string, any>) {
    const { path = '.', autoAdd = true, dryRun = false, llmAnalysis = '' } = parameters;

    try {
      // 1. 检查是否是Git仓库
      try {
        await execAsync('git rev-parse --git-dir', { cwd: path });
      } catch {
        throw new Error('当前目录不是Git仓库');
      }

      // 2. 检查是否有变更
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: path,
        timeout: 5000,
      });

      if (!statusOutput.trim() && !autoAdd) {
        return {
          success: false,
          error: '没有变更需要提交',
          data: { hasChanges: false },
        };
      }

      // 3. 如果需要自动添加文件
      if (autoAdd && statusOutput.trim()) {
        await execAsync('git add -A', { cwd: path, timeout: 10000 });
      }

      // 4. 获取暂存区的差异
      const { stdout: diffOutput } = await execAsync('git diff --cached', {
        cwd: path,
        timeout: 15000,
      });

      if (!diffOutput.trim()) {
        return {
          success: false,
          error: '暂存区没有变更，请先使用git add添加文件',
          data: { hasStagedChanges: false },
        };
      }

      // 5. 获取变更文件列表和统计
      const { stdout: diffStat } = await execAsync('git diff --cached --stat', {
        cwd: path,
        timeout: 10000,
      });

      const { stdout: diffNameOnly } = await execAsync('git diff --cached --name-only', {
        cwd: path,
        timeout: 10000,
      });

      // 6. 分析变更内容准备给LLM
      const changedFiles = diffNameOnly
        .trim()
        .split('\n')
        .filter(f => f.trim());

      // 限制diff内容长度，避免太长
      const truncatedDiff =
        diffOutput.length > 2000 ? diffOutput.substring(0, 2000) + '\n... (truncated)' : diffOutput;

      const analysisPrompt = `请分析以下Git变更内容，生成一个简洁、清晰的commit信息。

变更文件: ${changedFiles.join(', ')}

变更统计:
${diffStat}

详细变更内容:
\`\`\`diff
${truncatedDiff}
\`\`\`

请遵循以下规则生成commit信息：
1. 使用conventional commits格式: type(scope): description
2. type可以是: feat, fix, docs, style, refactor, perf, test, chore
3. 描述要简洁明了，说明实际做了什么
4. 使用中文描述
5. 只返回commit信息，不要其他解释

示例格式:
feat: 新增用户登录功能
fix: 修复数据库连接超时问题  
docs: 更新API文档
chore: 更新依赖版本`;

      let commitMessage = '';

      // 7. 如果有LLM分析结果，直接使用
      if (llmAnalysis) {
        commitMessage = llmAnalysis.trim();
      } else {
        // 否则返回分析提示，让Agent的LLM来处理
        return {
          success: false,
          error: 'need_llm_analysis',
          data: {
            needsLLMAnalysis: true,
            analysisPrompt,
            changedFiles,
            diffStat: diffStat.trim(),
            previewMode: dryRun,
          },
        };
      }

      // 8. 验证commit信息格式
      if (!commitMessage || commitMessage.length < 5) {
        throw new Error('生成的提交信息过短或无效');
      }

      // 9. 如果是干运行，返回预览
      if (dryRun) {
        return {
          success: true,
          data: {
            commitMessage,
            changedFiles,
            diffStat: diffStat.trim(),
            previewMode: true,
            wouldCommit: true,
          },
        };
      }

      // 10. 执行提交
      const commitCommand = `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`;
      const { stdout: commitOutput, stderr } = await execAsync(commitCommand, {
        cwd: path,
        timeout: 15000,
      });

      if (stderr && !stderr.includes('warning')) {
        throw new Error(stderr);
      }

      // 11. 解析提交结果
      const output = commitOutput.trim();
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

      // 12. 提取文件统计
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

      return {
        success: true,
        data: {
          commitMessage,
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
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Git smart commit failed: ${(error as Error).message}`,
        data: null,
      };
    }
  },
};
