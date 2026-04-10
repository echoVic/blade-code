/**
 * 工具调用格式化工具函数
 * 用于生成工具调用的摘要和判断是否显示详细内容
 */

import { basename } from 'node:path';
import { isEditMetadata, isGlobMetadata } from '../../tools/types/index.js';

/**
 * 格式化工具调用摘要（用于流式显示）
 * 生成清晰的执行日志，让用户知道正在做什么
 */
export function formatToolCallSummary(
  toolName: string,
  params: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Write': {
      const filePath = params.file_path as string;
      const fileName = filePath ? basename(filePath) : 'file';
      return `Writing ${fileName}`;
    }
    case 'Edit': {
      const filePath = params.file_path as string;
      const fileName = filePath ? basename(filePath) : 'file';
      return `Editing ${fileName}`;
    }
    case 'Read': {
      const filePath = params.file_path as string;
      const fileName = filePath ? basename(filePath) : 'file';
      return `Reading ${fileName}`;
    }
    case 'Bash': {
      const cmd = params.command as string;
      const desc = params.description as string;
      if (desc) {
        return `${desc}`;
      }
      const preview = cmd ? cmd.substring(0, 40) : 'command';
      return `Running: ${preview}${cmd && cmd.length > 40 ? '...' : ''}`;
    }
    case 'Glob': {
      const pattern = params.pattern as string;
      return `Searching files: ${pattern}`;
    }
    case 'Grep': {
      const pattern = params.pattern as string;
      const path = params.path as string;
      const truncatedPattern =
        pattern && pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern;
      if (path) {
        const pathName = basename(path);
        return `Searching "${truncatedPattern}" in ${pathName}`;
      }
      return `Searching "${truncatedPattern}"`;
    }
    case 'WebFetch': {
      const url = params.url as string;
      if (url) {
        try {
          const urlObj = new URL(url);
          return `Fetching ${urlObj.hostname}`;
        } catch {
          return `Fetching URL`;
        }
      }
      return 'Fetching URL';
    }
    case 'WebSearch': {
      const query = params.query as string;
      const truncatedQuery =
        query && query.length > 40 ? query.substring(0, 40) + '...' : query;
      return `Searching: "${truncatedQuery}"`;
    }
    case 'TodoWrite': {
      const todos = params.todos as unknown[];
      return `Updating tasks (${todos?.length || 0} items)`;
    }
    case 'UndoEdit': {
      const filePath = params.file_path as string;
      const fileName = filePath ? basename(filePath) : 'file';
      return `Undoing changes to ${fileName}`;
    }
    case 'Skill': {
      const skill = params.skill as string;
      return `Invoking skill: ${skill}`;
    }
    case 'Task': {
      const description = params.description as string;
      const subagentType = params.subagent_type as string;
      if (description) {
        return `${subagentType || 'Agent'}: ${description}`;
      }
      return `Running ${subagentType || 'agent'}`;
    }
    case 'LSP': {
      const operation = params.operation as string;
      const filePath = params.filePath as string;
      const fileName = filePath ? basename(filePath) : 'file';
      return `LSP ${operation} in ${fileName}`;
    }
    case 'NotebookEdit': {
      const notebookPath = params.notebook_path as string;
      const fileName = notebookPath ? basename(notebookPath) : 'notebook';
      return `Editing notebook: ${fileName}`;
    }
    // Spec Mode Tools
    case 'EnterSpecMode': {
      const name = params.name as string;
      return `Creating spec: ${name || 'new spec'}`;
    }
    case 'UpdateSpec': {
      const fileType = params.fileType as string;
      return `Updating ${fileType}.md`;
    }
    case 'GetSpecContext': {
      return `Getting spec context`;
    }
    case 'TransitionSpecPhase': {
      const targetPhase = params.targetPhase as string;
      return `Transitioning to: ${targetPhase}`;
    }
    case 'AddTask': {
      const title = params.title as string;
      const truncatedTitle =
        title && title.length > 30 ? title.substring(0, 30) + '...' : title;
      return `Adding task: ${truncatedTitle || 'task'}`;
    }
    case 'UpdateTaskStatus': {
      const status = params.status as string;
      const taskId = params.taskId as string;
      const statusIcon =
        status === 'completed' ? '[done]' : status === 'in_progress' ? '[in progress]' : '[paused]';
      return `${statusIcon} Task ${taskId?.substring(0, 8) || ''}: ${status}`;
    }
    case 'ValidateSpec': {
      return `Validating spec`;
    }
    case 'ExitSpecMode': {
      const archive = params.archive as boolean;
      return archive ? `Archiving spec` : `Exiting spec mode`;
    }
    default:
      return `${toolName}`;
  }
}

interface ToolResult {
  success?: boolean;
  displayContent?: string;
  llmContent?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * 判断是否显示工具详细内容
 */
export function shouldShowToolDetail(toolName: string, result: ToolResult): boolean {
  if (!result?.displayContent && !result?.success) return false;

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'Bash':
      // 这些工具总是显示紧凑预览
      return true;

    case 'WebFetch':
    case 'WebSearch':
      // 网络请求显示结果
      return true;

    case 'TodoWrite':
      // 不显示详细内容
      return false;

    default:
      // 其他工具默认显示（如果有详细内容）
      return !!result.metadata?.detail;
  }
}

/**
 * 生成工具详细内容
 * 用于在工具执行后显示更多信息
 *
 * 优化原则：
 * - 紧凑预览：只显示前几行/项
 * - 明确数量：显示 "... (+N more)" 表示剩余
 * - 简洁格式：避免过多装饰
 */
export function generateToolDetail(
  toolName: string,
  result: ToolResult
): string | null {
  if (!result?.success) return null;

  switch (toolName) {
    case 'Glob': {
      if (!isGlobMetadata(result.metadata)) return null;
      const { matches } = result.metadata;
      if (!matches?.length) return null;
      const maxShow = 5;
      const lines = matches.slice(0, maxShow).map((m) => m.relative_path);
      if (matches.length > maxShow) {
        lines.push(`... (+${matches.length - maxShow} more)`);
      }
      return lines.join('\n');
    }

    case 'Grep': {
      const matches = result.llmContent as Array<{
        file_path: string;
        line_number?: number;
        content?: string;
      }>;
      if (!Array.isArray(matches) || !matches.length) return null;
      const maxShow = 5;
      const lines = matches.slice(0, maxShow).map((m) => {
        const fileName = basename(m.file_path);
        if (m.line_number) {
          return `${fileName}:${m.line_number}`;
        }
        return fileName;
      });
      if (matches.length > maxShow) {
        lines.push(`... (+${matches.length - maxShow} more)`);
      }
      return lines.join('\n');
    }

    case 'Read': {
      const content =
        (result.metadata?.content_preview as string | undefined) || result.llmContent;
      if (typeof content !== 'string' || !content) return null;

      const lines = content.split('\n');
      const totalLines = lines.length;
      const PREVIEW_LINES = 3;

      if (totalLines <= PREVIEW_LINES + 1) {
        return content;
      }

      const previewLines = lines.slice(0, PREVIEW_LINES);
      return `${previewLines.join('\n')}\n... (+${totalLines - PREVIEW_LINES} line(s))`;
    }

    case 'Bash': {
      const llmContent = result.llmContent as
        | { stdout?: string; stderr?: string }
        | undefined;
      const stdout = llmContent?.stdout || '';
      const stderr = llmContent?.stderr || '';

      let output = stdout || stderr;
      if (!output) return null;

      const lines = output.split('\n');
      const maxLines = 8;
      if (lines.length > maxLines) {
        output =
          lines.slice(0, maxLines).join('\n') +
          `\n... (+${lines.length - maxLines} line(s))`;
      }

      if (stderr && !stdout) {
        return `${output}`;
      }
      return output;
    }

    case 'Write': {
      const content = result.metadata?.content as string | undefined;
      if (!content) return null;

      const lines = content.split('\n');
      const maxLines = 3;
      if (lines.length <= maxLines + 1) {
        return content.slice(0, 200);
      }
      return `${lines.slice(0, maxLines).join('\n')}\n... (+${lines.length - maxLines} line(s))`;
    }

    case 'Edit': {
      if (!isEditMetadata(result.metadata)) return null;
      const { diff_snippet } = result.metadata;
      if (diff_snippet) {
        const lines = diff_snippet.split('\n');
        const maxLines = 6;
        if (lines.length > maxLines) {
          return (
            lines.slice(0, maxLines).join('\n') +
            `\n... (+${lines.length - maxLines} line(s))`
          );
        }
        return diff_snippet;
      }
      return null;
    }

    default: {
      const detail = result.metadata?.detail;
      return typeof detail === 'string' ? detail : null;
    }
  }
}
