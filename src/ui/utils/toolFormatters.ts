/**
 * 工具调用格式化工具函数
 * 用于生成工具调用的摘要和判断是否显示详细内容
 */

/**
 * 格式化工具调用摘要（用于流式显示）
 */
export function formatToolCallSummary(
  toolName: string,
  params: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Write':
      return `Write(${params.file_path || 'file'})`;
    case 'Edit':
      return `Edit(${params.file_path || 'file'})`;
    case 'Read':
      return `Read(${params.file_path || 'file'})`;
    case 'Bash': {
      const cmd = params.command as string;
      return `Bash(${cmd ? cmd.substring(0, 50) : 'command'}${cmd && cmd.length > 50 ? '...' : ''})`;
    }
    case 'Glob':
      return `Glob(${params.pattern || '*'})`;
    case 'Grep': {
      const pattern = params.pattern as string;
      const path = params.path as string;
      if (path) {
        return `Grep("${pattern}" in ${path})`;
      }
      return `Grep("${pattern}")`;
    }
    case 'WebFetch': {
      const url = params.url as string;
      if (url) {
        try {
          const urlObj = new URL(url);
          return `WebFetch(${urlObj.hostname})`;
        } catch {
          return `WebFetch(${url.substring(0, 30)}${url.length > 30 ? '...' : ''})`;
        }
      }
      return 'WebFetch(url)';
    }
    case 'WebSearch':
      return `WebSearch("${params.query || 'query'}")`;
    case 'TodoWrite':
      return `TodoWrite(${(params.todos as unknown[])?.length || 0} items)`;
    case 'UndoEdit':
      return `UndoEdit(${params.file_path || 'file'})`;
    default:
      return `${toolName}()`;
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
      // 短输出显示（小于 1000 字符）
      return (result.metadata?.stdout_length || 0) < 1000;

    case 'Read':
    case 'TodoWrite':
    case 'TodoRead':
      // 不显示详细内容
      return false;

    default:
      // 其他工具默认不显示
      return false;
  }
}
