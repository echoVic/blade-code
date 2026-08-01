/**
 * Edit Corrector - 编辑纠错工具
 *
 * 提供多种策略自动修复 LLM 在调用 Edit 工具时的常见错误：
 * - 转义字符过多（\\n -> \n）
 * - 缩进不匹配（2 空格 vs 4 空格）
 * - 引号类型差异（智能引号 vs 普通引号）
 */

/**
 * 匹配策略枚举（按优先级排序）
 */
export enum MatchStrategy {
  EXACT = 'exact', // 精确匹配
  LINE_TRIM = 'line_trim', // 行尾空白修剪
  NORMALIZE_QUOTES = 'normalize_quotes', // 引号标准化匹配
  UNESCAPE = 'unescape', // 反转义匹配
  WHITESPACE_NORMALIZE = 'whitespace_normalize', // 空白归一化匹配
  FLEXIBLE = 'flexible', // 弹性缩进匹配
  BLOCK_ANCHOR = 'block_anchor', // 块锚点匹配（首尾行 + 相似度）
  FAILED = 'failed', // 所有策略都失败
}

/**
 * 匹配结果
 */
export interface MatchResult {
  matched: string | null; // 匹配到的实际字符串（保持原文件格式）
  strategy: MatchStrategy; // 使用的匹配策略
}

/**
 * 反转义字符串
 * 修复 LLM 过度转义的问题
 *
 * @param input 输入字符串
 * @returns 反转义后的字符串
 *
 * @example
 * unescapeString('line1\\nline2') // -> 'line1\nline2'
 * unescapeString('say \\"hello\\"') // -> 'say "hello"'
 * unescapeString('\\`template\\`') // -> '`template`'
 */
export function unescapeString(input: string): string {
  // 正则说明：
  // \\+ : 匹配一个或多个反斜杠
  // (n|t|r|'|"|`|\\|\n) : 捕获组，匹配需要转义的字符
  //   - n, t, r: 字面字符（需要转换为 \n, \t, \r）
  //   - ', ", `: 引号字符
  //   - \\: 反斜杠本身
  //   - \n: 真实的换行符
  // g: 全局标志，替换所有匹配

  return input.replace(/\\+(n|t|r|'|"|`|\\|\n)/g, (match, capturedChar) => {
    switch (capturedChar) {
      case 'n':
        return '\n'; // 换行符
      case 't':
        return '\t'; // 制表符
      case 'r':
        return '\r'; // 回车符
      case "'":
        return "'"; // 单引号
      case '"':
        return '"'; // 双引号
      case '`':
        return '`'; // 反引号
      case '\\':
        return '\\'; // 反斜杠
      case '\n':
        return '\n'; // 真实换行符
      default:
        return match; // 保持原样
    }
  });
}

/**
 * 弹性缩进匹配
 * 忽略缩进差异，在文件内容中查找匹配的字符串
 *
 * @param content 文件内容
 * @param searchString 要搜索的字符串
 * @returns 匹配到的实际字符串（保持原文件缩进），如果未找到则返回 null
 *
 * @example
 * const content = '  function foo() {\n    return 1;\n  }';
 * const search = '    function foo() {\n      return 1;\n    }';
 * flexibleMatch(content, search) // -> '  function foo() {\n    return 1;\n  }'
 */
export function flexibleMatch(content: string, searchString: string): string | null {
  const searchLines = searchString.split('\n');

  // 如果只有一行，无法使用弹性匹配
  if (searchLines.length === 1) {
    return null;
  }

  // 1. 提取搜索字符串的第一行缩进
  const firstLine = searchLines[0];
  const indentMatch = firstLine.match(/^(\s+)/);

  if (!indentMatch) {
    return null; // 第一行没有缩进，无法使用弹性匹配
  }

  const searchIndent = indentMatch[1];

  // 2. 去除搜索字符串的缩进
  const deindentedSearchLines = searchLines.map((line) => {
    if (line.startsWith(searchIndent)) {
      return line.slice(searchIndent.length);
    }
    return line;
  });
  const deindentedSearch = deindentedSearchLines.join('\n');

  // 3. 在文件内容中搜索
  const contentLines = content.split('\n');

  // 尝试在每个可能的位置匹配
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const lineIndentMatch = contentLines[i].match(/^(\s+)/);
    const fileIndent = lineIndentMatch ? lineIndentMatch[1] : '';

    // 提取从当前行开始的内容片段（与搜索字符串行数相同）
    const snippet = contentLines.slice(i, i + searchLines.length);

    // 去除文件片段的缩进
    const deindentedSnippet = snippet.map((line) => {
      if (line.startsWith(fileIndent)) {
        return line.slice(fileIndent.length);
      }
      return line;
    });
    const deindentedContent = deindentedSnippet.join('\n');

    // 如果去除缩进后完全匹配
    if (deindentedContent === deindentedSearch) {
      // 返回原文件中的实际字符串（保持原始缩进）
      return snippet.join('\n');
    }
  }

  return null;
}

/**
 * 行级空白修剪匹配
 * 忽略每行的尾部空白差异（LLM 经常在行尾添加或遗漏空格）
 */
export function lineTrimMatch(content: string, searchString: string): string | null {
  const searchLines = searchString.split('\n');
  const contentLines = content.split('\n');
  const trimmedSearch = searchLines.map((l) => l.trimEnd());

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const snippet = contentLines.slice(i, i + searchLines.length);
    const trimmedSnippet = snippet.map((l) => l.trimEnd());

    if (
      trimmedSnippet.length === trimmedSearch.length &&
      trimmedSnippet.every((line, idx) => line === trimmedSearch[idx])
    ) {
      return snippet.join('\n');
    }
  }

  return null;
}

/**
 * 空白归一化匹配
 * 将连续空白字符视为单个空格（处理 tab/space 混用、多余空格等）
 * 保留换行符结构，仅归一化行内空白
 */
export function whitespaceNormalizeMatch(
  content: string,
  searchString: string
): string | null {
  const normalizeInline = (s: string) =>
    s
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n');

  const normalizedSearch = normalizeInline(searchString);
  const searchLineCount = searchString.split('\n').length;
  const contentLines = content.split('\n');

  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const snippet = contentLines.slice(i, i + searchLineCount);
    const normalizedSnippet = normalizeInline(snippet.join('\n'));

    if (normalizedSnippet === normalizedSearch) {
      return snippet.join('\n');
    }
  }

  return null;
}

/**
 * 块锚点匹配
 * 使用首行和尾行作为锚点精确匹配，中间行使用相似度容错
 * 适用于 LLM 对中间行有轻微拼写或格式差异的情况
 */
export function blockAnchorMatch(content: string, searchString: string): string | null {
  const searchLines = searchString.split('\n');
  if (searchLines.length < 3) return null;

  const contentLines = content.split('\n');
  const firstSearchTrimmed = searchLines[0].trim();
  const lastSearchTrimmed = searchLines[searchLines.length - 1].trim();
  const searchLineCount = searchLines.length;

  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const firstContentTrimmed = contentLines[i].trim();
    const lastContentTrimmed = contentLines[i + searchLineCount - 1].trim();

    if (firstContentTrimmed !== firstSearchTrimmed) continue;
    if (lastContentTrimmed !== lastSearchTrimmed) continue;

    const snippet = contentLines.slice(i, i + searchLineCount);
    const middleContent = snippet.slice(1, -1).join('\n');
    const middleSearch = searchLines.slice(1, -1).join('\n');

    const similarity = computeLineSimilarity(middleContent, middleSearch);
    if (similarity >= 0.85) {
      return snippet.join('\n');
    }
  }

  return null;
}

function computeLineSimilarity(a: string, b: string): number {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  if (aLines.length !== bLines.length) return 0;
  if (aLines.length === 0) return 1;

  let matches = 0;
  for (let i = 0; i < aLines.length; i++) {
    if (aLines[i].trim() === bLines[i].trim()) {
      matches++;
    }
  }
  return matches / aLines.length;
}
