/**
 * 工具调用格式化工具函数
 * 用于生成工具调用的摘要和判断是否显示详细内容
 */

import { basename } from 'node:path';
import { isEditMetadata, isGlobMetadata } from '../../tools/types/index.js';
import type { ToolDisplayOutput } from '../../tools/types/ToolTypes.js';

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
    case 'ApplyPatch': {
      const patchText = params.patch as string;
      const count = patchText
        ? (patchText.match(/^\*\*\* (?:Add|Delete|Update) File: /gm) ?? []).length
        : 0;
      return `Applying atomic patch${count > 0 ? ` to ${count} file(s)` : ''}`;
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
    case 'WriteStdin': {
      const shellId = params.shell_id as string;
      return `Sending input to Shell: ${shellId || 'unknown'}`;
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
    case 'TaskCreate': {
      const subject = params.subject as string;
      return `Creating task: ${subject || 'task'}`;
    }
    case 'TaskGet': {
      const taskId = params.taskId as string;
      return `Reading task ${taskId || ''}`.trim();
    }
    case 'TaskUpdate': {
      const status = params.status as string | undefined;
      const taskId = params.taskId as string;
      return status
        ? `Updating task ${taskId || ''}: ${status}`.trim()
        : `Updating task ${taskId || ''}`.trim();
    }
    case 'TaskList': {
      return `Listing tasks`;
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
      const resumedFrom = (params.resume_from || params.resume) as string | undefined;
      if (resumedFrom) {
        return `Resuming ${subagentType || 'agent'} from ${resumedFrom}`;
      }
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
    default:
      return `${toolName}`;
  }
}

interface ToolResult {
  success?: boolean;
  llmContent?: unknown;
  error?: { message: string; type?: string };
  metadata?: Record<string, unknown>;
}

/**
 * 判断是否显示工具详细内容
 */
export function shouldShowToolDetail(toolName: string, result: ToolResult): boolean {
  if (!result?.success && !result?.metadata && toolName !== 'Bash') return false;

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'ApplyPatch':
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'Bash':
    case 'TaskOutput':
      // 这些工具总是显示紧凑预览
      return true;

    case 'WebFetch':
    case 'WebSearch':
      // 网络请求显示结果
      return true;

    case 'TaskCreate':
    case 'TaskGet':
    case 'TaskUpdate':
    case 'TaskList':
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
  if (!result?.success && toolName !== 'Bash') return null;

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
        | {
            stdout?: string;
            stderr?: string;
            output_truncated?: boolean;
            truncation_info?: string;
          }
        | undefined;
      const stdout =
        llmContent && typeof llmContent === 'object' ? llmContent.stdout || '' : '';
      const stderr =
        llmContent && typeof llmContent === 'object' ? llmContent.stderr || '' : '';
      const compactStream = (content: string): string => {
        const safeHead = (value: string, count: number) => {
          let end = Math.min(value.length, count);
          if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) {
            end -= 1;
          }
          return value.slice(0, end);
        };
        const safeTail = (value: string, count: number) => {
          let start = Math.max(0, value.length - count);
          if (/[\uDC00-\uDFFF]/.test(value.charAt(start))) start += 1;
          return value.slice(start);
        };
        const lines = content.split('\n');
        const maxLines = 8;
        const lineBounded =
          lines.length > maxLines
            ? [
                ...lines.slice(0, 4),
                `... (+${lines.length - maxLines} line(s); tail shown)`,
                ...lines.slice(-4),
              ].join('\n')
            : content;
        const maxChars = 800;
        if (lineBounded.length <= maxChars) return lineBounded;
        const marker = '\n... (middle clipped; tail shown) ...\n';
        const headChars = 240;
        const tailChars = maxChars - headChars - marker.length;
        return `${safeHead(lineBounded, headChars)}${marker}${safeTail(
          lineBounded,
          tailChars
        )}`;
      };

      const sections: string[] = [];
      if (stdout) sections.push(`stdout:\n${compactStream(stdout)}`);
      if (stderr) sections.push(`stderr:\n${compactStream(stderr)}`);
      if (sections.length === 0 && result.error?.message) {
        sections.push(compactStream(result.error.message));
      } else if (
        sections.length === 0 &&
        typeof result.llmContent === 'string' &&
        result.llmContent
      ) {
        sections.push(compactStream(result.llmContent));
      }

      const outputTruncated =
        llmContent?.output_truncated === true ||
        result.metadata?.output_truncated === true;
      const omittedBytes =
        (typeof result.metadata?.stdout_omitted_bytes === 'number'
          ? result.metadata.stdout_omitted_bytes
          : 0) +
        (typeof result.metadata?.stderr_omitted_bytes === 'number'
          ? result.metadata.stderr_omitted_bytes
          : 0);
      const truncationNotice =
        typeof llmContent?.truncation_info === 'string'
          ? llmContent.truncation_info
          : outputTruncated
            ? omittedBytes > 0
              ? `Output truncated: ${omittedBytes} earlier bytes omitted; retained tail shown`
              : 'Output truncated for display; retained tail shown'
            : undefined;
      if (truncationNotice) sections.push(truncationNotice);

      return sections.join('\n') || null;
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

    case 'ApplyPatch': {
      const changes = result.metadata?.changes;
      if (!Array.isArray(changes)) return null;
      const markers = { add: 'A', update: 'M', delete: 'D' } as const;
      return changes
        .slice(0, 20)
        .map((change) => {
          if (
            !change ||
            typeof change !== 'object' ||
            !('kind' in change) ||
            !('path' in change)
          ) {
            return null;
          }
          const kind = change.kind as keyof typeof markers;
          return `${markers[kind] ?? 'M'} ${String(change.path)}`;
        })
        .filter((line): line is string => Boolean(line))
        .join('\n');
    }

    case 'WebFetch': {
      const content = result.llmContent as
        | { status?: number; url?: string; body?: string; status_text?: string }
        | undefined;
      if (!content) return null;
      const parts: string[] = [];
      if (content.url) {
        parts.push(`${content.status || ''} ${content.url}`.trim());
      }
      if (content.body) {
        const preview = content.body.slice(0, 800);
        parts.push(
          preview.length < content.body.length ? `${preview}\n... (truncated)` : preview
        );
      }
      return parts.join('\n') || null;
    }

    case 'WebSearch': {
      const results = result.llmContent as
        | Array<{ title?: string; url?: string }>
        | string
        | undefined;
      if (!results) return null;
      if (typeof results === 'string') {
        const lines = results.split('\n');
        const maxShow = 5;
        if (lines.length > maxShow) {
          return (
            lines.slice(0, maxShow).join('\n') +
            `\n... (+${lines.length - maxShow} more)`
          );
        }
        return results || null;
      }
      if (Array.isArray(results) && results.length > 0) {
        const maxShow = 5;
        const lines = results.slice(0, maxShow).map((r) => r.title || r.url || '');
        if (results.length > maxShow) {
          lines.push(`... (+${results.length - maxShow} more)`);
        }
        return lines.join('\n');
      }
      return null;
    }

    case 'Task': {
      const summary =
        (result.metadata?.subagentSummary as string) ||
        (typeof result.llmContent === 'string' ? result.llmContent : null);
      const resumedFrom = result.metadata?.subagentResumedFrom as string | undefined;
      const lineage = resumedFrom
        ? `Resumed from ${resumedFrom} (depth ${String(result.metadata?.subagentResumeDepth ?? 1)})`
        : undefined;
      if (!summary) return lineage ?? null;
      const bounded = summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
      return lineage ? `${lineage}\n${bounded}` : bounded;
    }

    case 'TaskOutput': {
      if (typeof result.llmContent === 'string') {
        return result.llmContent.length > 200
          ? `${result.llmContent.slice(0, 200)}...`
          : result.llmContent;
      }
      if (!result.llmContent || typeof result.llmContent !== 'object') return null;

      const payload = result.llmContent as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof payload.status === 'string') {
        parts.push(`Status: ${payload.status}`);
      }
      if (typeof payload.resumed_from === 'string') {
        parts.push(
          `Resumed from: ${payload.resumed_from} (depth ${String(payload.resume_depth ?? 1)})`
        );
      }

      if (payload.output_truncated === true) {
        const omittedBytes =
          (typeof payload.stdout_omitted_bytes === 'number'
            ? payload.stdout_omitted_bytes
            : 0) +
          (typeof payload.stderr_omitted_bytes === 'number'
            ? payload.stderr_omitted_bytes
            : 0);
        parts.push(
          omittedBytes > 0
            ? `Output truncated: ${omittedBytes} earlier bytes omitted`
            : 'Output truncated for display'
        );
      }

      const appendTail = (label: string, value: unknown) => {
        if (typeof value !== 'string' || value.length === 0) return;
        const maxLength = 160;
        const tail = value.length > maxLength ? `...${value.slice(-maxLength)}` : value;
        parts.push(`${label}: ${tail}`);
      };
      appendTail('stdout', payload.stdout);
      appendTail('stderr', payload.stderr);

      return parts.join('\n') || null;
    }

    case 'Skill': {
      const skillName = result.metadata?.skillName as string | undefined;
      return skillName ? `Skill: ${skillName}` : null;
    }

    default: {
      const detail = result.metadata?.detail;
      return typeof detail === 'string' ? detail : null;
    }
  }
}

/**
 * 统一工具展示格式化入口
 * 所有面向用户的展示（CLI TUI / Web SSE / Headless / ACP）都应通过此函数
 */
export function formatToolDisplay(
  toolName: string,
  result: ToolResult
): ToolDisplayOutput {
  const status: ToolDisplayOutput['status'] = result.success
    ? 'ok'
    : result.error
      ? 'fail'
      : 'warn';
  const summary =
    (result.metadata?.summary as string | undefined) ||
    (result.success ? '执行成功' : '执行失败');
  const detail = shouldShowToolDetail(toolName, result)
    ? generateToolDetail(toolName, result) || undefined
    : undefined;
  return { status, summary, detail };
}

/**
 * 将 ToolDisplayOutput 渲染为纯文本字符串
 * 用于 Web SSE、ACP、Headless 等需要单一字符串的消费者
 */
export function renderToolDisplayToString(display: ToolDisplayOutput): string {
  const prefix = { ok: '[OK]', fail: '[FAIL]', warn: '[WARN]' }[display.status];
  return display.detail
    ? `${prefix} ${display.summary}\n${display.detail}`
    : `${prefix} ${display.summary}`;
}
