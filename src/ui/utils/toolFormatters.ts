/**
 * 工具调用格式化工具函数
 * 用于生成工具调用的摘要和判断是否显示详细内容
 */

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
      const fileName = filePath?.split('/').pop() || 'file';
      return `📝 Writing ${fileName}`;
    }
    case 'Edit': {
      const filePath = params.file_path as string;
      const fileName = filePath?.split('/').pop() || 'file';
      return `✏️ Editing ${fileName}`;
    }
    case 'Read': {
      const filePath = params.file_path as string;
      const fileName = filePath?.split('/').pop() || 'file';
      return `📖 Reading ${fileName}`;
    }
    case 'Bash': {
      const cmd = params.command as string;
      const desc = params.description as string;
      if (desc) {
        return `⚡ ${desc}`;
      }
      const preview = cmd ? cmd.substring(0, 40) : 'command';
      return `⚡ Running: ${preview}${cmd && cmd.length > 40 ? '...' : ''}`;
    }
    case 'Glob': {
      const pattern = params.pattern as string;
      return `🔍 Searching files: ${pattern}`;
    }
    case 'Grep': {
      const pattern = params.pattern as string;
      const path = params.path as string;
      const truncatedPattern =
        pattern && pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern;
      if (path) {
        const pathName = path.split('/').pop() || path;
        return `🔎 Searching "${truncatedPattern}" in ${pathName}`;
      }
      return `🔎 Searching "${truncatedPattern}"`;
    }
    case 'WebFetch': {
      const url = params.url as string;
      if (url) {
        try {
          const urlObj = new URL(url);
          return `🌐 Fetching ${urlObj.hostname}`;
        } catch {
          return `🌐 Fetching URL`;
        }
      }
      return '🌐 Fetching URL';
    }
    case 'WebSearch': {
      const query = params.query as string;
      const truncatedQuery =
        query && query.length > 40 ? query.substring(0, 40) + '...' : query;
      return `🔍 Searching: "${truncatedQuery}"`;
    }
    case 'TodoWrite': {
      const todos = params.todos as unknown[];
      return `📋 Updating tasks (${todos?.length || 0} items)`;
    }
    case 'UndoEdit': {
      const filePath = params.file_path as string;
      const fileName = filePath?.split('/').pop() || 'file';
      return `↩️ Undoing changes to ${fileName}`;
    }
    case 'Skill': {
      const skill = params.skill as string;
      return `🎯 Invoking skill: ${skill}`;
    }
    case 'Task': {
      const description = params.description as string;
      const subagentType = params.subagent_type as string;
      if (description) {
        return `🤖 ${subagentType || 'Agent'}: ${description}`;
      }
      return `🤖 Running ${subagentType || 'agent'}`;
    }
    case 'LSP': {
      const operation = params.operation as string;
      const filePath = params.filePath as string;
      const fileName = filePath?.split('/').pop() || 'file';
      return `🔗 LSP ${operation} in ${fileName}`;
    }
    case 'NotebookEdit': {
      const notebookPath = params.notebook_path as string;
      const fileName = notebookPath?.split('/').pop() || 'notebook';
      return `📓 Editing notebook: ${fileName}`;
    }
    default:
      return `⚙️ ${toolName}`;
  }
}

/**
 * 判断是否显示工具详细内容
 */
export function shouldShowToolDetail(toolName: string, result: any): boolean {
  if (!result?.displayContent) return false;

  switch (toolName) {
    case 'Write':
      // 小文件显示预览（小于 10KB）
      return (result.metadata?.file_size || 0) < 10000;

    case 'Edit':
      // 总是显示 diff 片段
      return true;

    case 'Bash':
      // 短输出显示（小于 2000 字符）
      return (result.metadata?.stdout_length || 0) < 2000;

    case 'Glob':
      // 显示匹配文件列表（最多 20 个）
      return (result.metadata?.total_matches || 0) <= 20;

    case 'Grep':
      // 显示匹配结果（最多 15 条）
      return (result.metadata?.total_matches || 0) <= 15;

    case 'WebFetch':
    case 'WebSearch':
      // 总是显示网络请求结果
      return true;

    case 'Read':
      // 小文件显示预览（小于 3000 字符）
      return (result.metadata?.content_length || 0) < 3000;

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
 */
export function generateToolDetail(toolName: string, result: any): string | null {
  if (!result?.success) return null;

  switch (toolName) {
    case 'Glob': {
      const matches = result.metadata?.matches as Array<{ relative_path: string }>;
      if (!matches?.length) return null;
      const maxShow = 20;
      const lines = matches.slice(0, maxShow).map((m) => `  📄 ${m.relative_path}`);
      if (matches.length > maxShow) {
        lines.push(`  ... 还有 ${matches.length - maxShow} 个文件`);
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
      const maxShow = 15;
      const lines = matches.slice(0, maxShow).map((m) => {
        if (m.line_number && m.content) {
          const content =
            m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content;
          return `  ${m.file_path}:${m.line_number}: ${content}`;
        }
        return `  📄 ${m.file_path}`;
      });
      if (matches.length > maxShow) {
        lines.push(`  ... 还有 ${matches.length - maxShow} 条匹配`);
      }
      return lines.join('\n');
    }

    case 'Read': {
      // 显示文件内容预览
      const content = result.metadata?.content_preview || result.llmContent;
      if (typeof content !== 'string' || !content) return null;
      const preview =
        content.length > 500 ? content.slice(0, 500) + '\n... (已截断)' : content;
      return preview;
    }

    case 'Bash': {
      const stdout = result.llmContent?.stdout || '';
      const stderr = result.llmContent?.stderr || '';
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`⚠️ ${stderr}`);
      return parts.join('\n') || null;
    }

    default:
      return result.metadata?.detail || null;
  }
}
