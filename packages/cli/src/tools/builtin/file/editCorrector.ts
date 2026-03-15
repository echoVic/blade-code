/**
 * Edit Corrector - 编辑纠错工具
 *
 * 提供多种策略自动修复 LLM 在调用 Edit 工具时的常见错误：
 * - 转义字符过多（\\n → \n）
 * - 缩进不匹配（2 空格 vs 4 空格）
 * - 引号类型差异（智能引号 vs 普通引号）
 */

/**
 * 匹配策略枚举
 */
export enum MatchStrategy {
  EXACT = 'exact', // 精确匹配
  NORMALIZE_QUOTES = 'normalize_quotes', // 引号标准化匹配
  UNESCAPE = 'unescape', // 反转义匹配
  FLEXIBLE = 'flexible', // 弹性缩进匹配
  FUZZY = 'fuzzy', // 模糊匹配（允许微小差异）
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
 * 字符串标准化（用于比较）
 */
function normalizeForComparison(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    // 统一双引号
    .replace(/[\u201c\u201d"]/g, '"')
    // 统一单引号
    .replace(/[\u2018\u2019']/g, "'");
}

/**
 * 反转义字符串
 * 修复 LLM 过度转义的问题
 *
 * @param input 输入字符串
 * @returns 反转义后的字符串
 *
 * @example
 * unescapeString('line1\\nline2') // → 'line1\nline2'
 * unescapeString('say \\"hello\\"') // → 'say "hello"'
 * unescapeString('\\`template\\`') // → '`template`'
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
 * 忽略缩进差异，并在标准化行内容后进行匹配
 */
export function flexibleMatch(
  content: string,
  searchString: string
): string | null {
  const searchLines = searchString.split('\n');

  // 如果只有一行，尝试标准化后匹配
  if (searchLines.length === 1) {
    const searchNorm = normalizeForComparison(searchString);
    const contentLines = content.split('\n');
    for (let i = 0; i < contentLines.length; i++) {
      if (normalizeForComparison(contentLines[i]) === searchNorm) {
        return contentLines[i];
      }
    }
    return null;
  }

  // 多行匹配逻辑
  const searchLinesNorm = searchLines.map(normalizeForComparison);
  const contentLines = content.split('\n');

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const snippet = contentLines.slice(i, i + searchLines.length);
    const snippetNorm = snippet.map(normalizeForComparison);

    // 逐行比较标准化后的内容
    let allMatch = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (snippetNorm[j] !== searchLinesNorm[j]) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      return snippet.join('\n');
    }
  }

  return null;
}

/**
 * 模糊匹配 (Patch 容错算法)
 * 允许少量行由于 LLM 生成时的格式微差（如缺失分号、微小拼写差异）导致的失配
 */
export function fuzzyMatch(
  content: string,
  searchString: string,
  threshold = 0.95
): string | null {
  const searchLines = searchString.split('\n');
  const contentLines = content.split('\n');

  // 仅在多行场景下启用窗口模糊匹配
  if (searchLines.length < 2) return null;

  let bestMatch: string | null = null;
  let highestSim = 0;
  let matchCount = 0;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const snippet = contentLines.slice(i, i + searchLines.length);
    
    // 计算多行块的综合相似度
    const similarity = calculateBlockSimilarity(searchLines, snippet);

    if (similarity >= threshold) {
      if (similarity > highestSim) {
        highestSim = similarity;
        bestMatch = snippet.join('\n');
      }
      matchCount++;
    }
  }

  // 🔴 关键安全控制：只有找到唯一且高置信度的模糊匹配时才自动纠错
  return matchCount === 1 && highestSim > 0.98 ? bestMatch : null;
}

/**
 * 计算两个代码块的行平均相似度
 */
function calculateBlockSimilarity(searchLines: string[], snippet: string[]): number {
  let totalSim = 0;
  for (let i = 0; i < searchLines.length; i++) {
    totalSim += calculateLineSimilarity(
      normalizeForComparison(searchLines[i]),
      normalizeForComparison(snippet[i])
    );
  }
  return totalSim / searchLines.length;
}

/**
 * 极简相似度算法 (Jaro-Winkler 风格)
 */
function calculateLineSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0;

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  // 简单的前缀匹配 + 长度比例
  let commonPrefix = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (s1[i] === s2[i]) commonPrefix++;
    else break;
  }
  
  return (commonPrefix / longer.length) * 0.4 + (shorter.length / longer.length) * 0.6;
}
