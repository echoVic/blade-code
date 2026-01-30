/**
 * 差异生成工具函数
 * 提供 Edit 和 Write 工具共享的 diff 生成能力
 */

import * as Diff from 'diff';

/**
 * 生成差异片段（使用 unified diff 格式，显示替换前后的代码上下文）
 *
 * @param oldContent 旧文件内容
 * @param newContent 新文件内容
 * @param contextLines 上下文行数（默认 4 行）
 * @returns diff 片段（JSON 格式，包含 patch 和行号信息）或 null
 */
export function generateDiffSnippet(
  oldContent: string,
  newContent: string,
  contextLines: number = 4
): string | null {
  // 如果内容完全相同，不生成 diff
  if (oldContent === newContent) {
    return null;
  }

  // 使用 diff 库生成 unified diff
  const patch = Diff.createPatch('file', oldContent, newContent, '', '', {
    context: contextLines,
  });

  // 计算第一个变更位置的行号
  const lines = patch.split('\n');
  let matchLine = 1;
  for (const line of lines) {
    const hunkMatch = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (hunkMatch) {
      matchLine = parseInt(hunkMatch[1], 10);
      break;
    }
  }

  // 返回特殊格式，包含 patch 和行号信息
  // 使用特殊分隔符 <<<DIFF>>>，方便 MessageRenderer 识别为 diff 内容
  return `\n<<<DIFF>>>\n${JSON.stringify({
    patch,
    startLine: Math.max(1, matchLine - contextLines),
    matchLine,
  })}\n<<</DIFF>>>\n`;
}

/**
 * 生成带有特定替换位置的差异片段（用于 Edit 工具）
 *
 * @param oldContent 旧文件内容
 * @param newContent 新文件内容
 * @param oldString 被替换的字符串
 * @param newString 替换后的字符串
 * @param contextLines 上下文行数（默认 4 行）
 * @returns diff 片段或 null
 */
export function generateDiffSnippetWithMatch(
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string,
  contextLines: number = 4
): string | null {
  // 找到第一个替换位置
  const firstMatchIndex = oldContent.indexOf(oldString);
  if (firstMatchIndex === -1) return null;

  // 计算替换位置的行号
  const beforeLines = oldContent.substring(0, firstMatchIndex).split('\n');
  const matchLine = beforeLines.length - 1;

  // 分割旧内容和新内容为行数组
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // 计算显示范围（考虑替换可能改变行数）
  const oldStringLines = oldString.split('\n');
  const newStringLines = newString.split('\n');
  const startLine = Math.max(0, matchLine - contextLines);
  const oldEndLine = Math.min(
    oldLines.length,
    matchLine + oldStringLines.length + contextLines
  );
  const newEndLine = Math.min(
    newLines.length,
    matchLine + newStringLines.length + contextLines
  );

  // 提取上下文片段
  const oldSnippet = oldLines.slice(startLine, oldEndLine).join('\n');
  const newSnippet = newLines.slice(startLine, newEndLine).join('\n');

  // 使用 diff 库生成 unified diff
  const patch = Diff.createPatch('file', oldSnippet, newSnippet, '', '', {
    context: contextLines,
  });

  // 返回特殊格式，包含 patch 和行号信息
  return `\n<<<DIFF>>>\n${JSON.stringify({
    patch,
    startLine: startLine + 1,
    matchLine: matchLine + 1,
  })}\n<<</DIFF>>>\n`;
}
