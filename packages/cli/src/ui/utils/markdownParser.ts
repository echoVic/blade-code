/**
 * Markdown 解析器
 * 将文本解析为结构化块，供 MessageRenderer 使用
 */

export const MARKDOWN_PATTERNS = {
  codeBlock: /^```(\w+)?\s*$/,
  heading: /^ *(#{1,4}) +(.+)/,
  ulItem: /^([ \t]*)([-*+]) +(.+)/,
  olItem: /^([ \t]*)(\d+)\. +(.+)/,
  hr: /^ *([-*_] *){3,} *$/,
  table: /^\|(.+)\|$/,
  tableSeparator: /^\|[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)+\|?$/,
  diffStart: /^<<<DIFF>>>$/,
  diffEnd: /^<<<\/DIFF>>>$/,
  commandMessage: /<command-message>(.*?)<\/command-message>/,
} as const;

export interface ParsedBlock {
  type:
    | 'text'
    | 'code'
    | 'heading'
    | 'table'
    | 'list'
    | 'hr'
    | 'empty'
    | 'diff'
    | 'command-message';
  content: string;
  language?: string;
  level?: number;
  listType?: 'ul' | 'ol';
  marker?: string;
  indentation?: number;
  tableData?: {
    headers: string[];
    rows: string[][];
  };
  diffData?: {
    patch: string;
    startLine: number;
    matchLine: number;
  };
}

/**
 * 解析 Markdown 内容为结构化块
 *
 * 嵌套代码块处理策略：
 * - 使用嵌套深度计数器跟踪代码块层级
 * - 只有当深度归零时才真正结束代码块
 * - `markdown` 语言的代码块会被"解包"，其内容作为普通 markdown 重新解析
 */
export function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = content.split(/\r?\n/);

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockDepth = 0; // 嵌套深度计数器

  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];

  let inDiff = false;
  let diffContent: string[] = [];

  let lastLineEmpty = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Diff 块处理
    if (inDiff) {
      if (line.match(MARKDOWN_PATTERNS.diffEnd)) {
        // Diff 块结束
        try {
          const diffJson = JSON.parse(diffContent.join('\n'));
          blocks.push({
            type: 'diff',
            content: '',
            diffData: {
              patch: diffJson.patch,
              startLine: diffJson.startLine,
              matchLine: diffJson.matchLine,
            },
          });
        } catch (_error) {
          // 解析失败，当作普通文本
          blocks.push({
            type: 'text',
            content: diffContent.join('\n'),
          });
        }
        inDiff = false;
        diffContent = [];
        lastLineEmpty = false;
        continue;
      }
      diffContent.push(line);
      continue;
    }

    // 检查 Diff 块开始
    if (line.match(MARKDOWN_PATTERNS.diffStart)) {
      inDiff = true;
      diffContent = [];
      lastLineEmpty = false;
      continue;
    }

    // 代码块处理（支持嵌套）
    if (inCodeBlock) {
      const codeBlockStartMatch = line.match(MARKDOWN_PATTERNS.codeBlock);
      const isCodeBlockEnd = line.trim() === '```'; // 纯结束标记

      if (codeBlockStartMatch && codeBlockStartMatch[1]) {
        // 遇到新的代码块开始（带语言标识），增加嵌套深度
        codeBlockDepth++;
        codeBlockContent.push(line);
      } else if (isCodeBlockEnd) {
        // 遇到代码块结束标记
        if (codeBlockDepth > 0) {
          // 还在嵌套中，减少深度，继续收集
          codeBlockDepth--;
          codeBlockContent.push(line);
        } else {
          // 最外层代码块结束
          const codeContent = codeBlockContent.join('\n');

          // 特殊处理 markdown 语言的代码块：解包并递归解析
          if (
            codeBlockLang?.toLowerCase() === 'markdown' ||
            codeBlockLang?.toLowerCase() === 'md'
          ) {
            const innerBlocks = parseMarkdown(codeContent);
            blocks.push(...innerBlocks);
          } else {
            blocks.push({
              type: 'code',
              content: codeContent,
              language: codeBlockLang || undefined,
            });
          }

          inCodeBlock = false;
          codeBlockContent = [];
          codeBlockLang = null;
          codeBlockDepth = 0;
          lastLineEmpty = false;
        }
      } else {
        codeBlockContent.push(line);
      }
      continue;
    }

    // 检查代码块开始
    const codeBlockMatch = line.match(MARKDOWN_PATTERNS.codeBlock);
    if (codeBlockMatch) {
      inCodeBlock = true;
      codeBlockLang = codeBlockMatch[1] || null;
      codeBlockDepth = 0;
      lastLineEmpty = false;
      continue;
    }

    // 表格处理
    const tableMatch = line.match(MARKDOWN_PATTERNS.table);
    const tableSepMatch = line.match(MARKDOWN_PATTERNS.tableSeparator);

    if (tableMatch && !inTable) {
      // 检查下一行是否是分隔符
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.match(MARKDOWN_PATTERNS.tableSeparator)) {
          inTable = true;
          tableHeaders = tableMatch[1]
            .split('|')
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0);
          tableRows = [];
          lastLineEmpty = false;
          continue;
        }
      }
    }

    if (inTable && tableSepMatch) {
      // 跳过分隔符行
      continue;
    }

    if (inTable && tableMatch) {
      // 添加表格行
      const cells = tableMatch[1]
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);

      // 确保列数一致
      while (cells.length < tableHeaders.length) {
        cells.push('');
      }
      if (cells.length > tableHeaders.length) {
        cells.length = tableHeaders.length;
      }

      tableRows.push(cells);
      continue;
    }

    if (inTable && !tableMatch) {
      // 表格结束
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        blocks.push({
          type: 'table',
          content: '',
          tableData: { headers: tableHeaders, rows: tableRows },
        });
      }
      inTable = false;
      tableHeaders = [];
      tableRows = [];
    }

    // 标题
    const headingMatch = line.match(MARKDOWN_PATTERNS.heading);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        content: headingMatch[2],
        level: headingMatch[1].length,
      });
      lastLineEmpty = false;
      continue;
    }

    // 无序列表
    const ulMatch = line.match(MARKDOWN_PATTERNS.ulItem);
    if (ulMatch) {
      blocks.push({
        type: 'list',
        content: ulMatch[3],
        listType: 'ul',
        marker: ulMatch[2],
        indentation: ulMatch[1].length,
      });
      lastLineEmpty = false;
      continue;
    }

    // 有序列表
    const olMatch = line.match(MARKDOWN_PATTERNS.olItem);
    if (olMatch) {
      blocks.push({
        type: 'list',
        content: olMatch[3],
        listType: 'ol',
        marker: olMatch[2],
        indentation: olMatch[1].length,
      });
      lastLineEmpty = false;
      continue;
    }

    // 水平线
    const hrMatch = line.match(MARKDOWN_PATTERNS.hr);
    if (hrMatch) {
      blocks.push({
        type: 'hr',
        content: '',
      });
      lastLineEmpty = false;
      continue;
    }

    // 空行
    if (line.trim().length === 0) {
      if (!lastLineEmpty) {
        blocks.push({
          type: 'empty',
          content: '',
        });
        lastLineEmpty = true;
      }
      continue;
    }

    // <command-message> 标签
    const commandMessageMatch = line.match(MARKDOWN_PATTERNS.commandMessage);
    if (commandMessageMatch) {
      blocks.push({
        type: 'command-message',
        content: commandMessageMatch[1],
      });
      lastLineEmpty = false;
      continue;
    }

    // 普通文本
    blocks.push({
      type: 'text',
      content: line,
    });
    lastLineEmpty = false;
  }

  // 处理未闭合的代码块
  if (inCodeBlock) {
    const codeContent = codeBlockContent.join('\n');

    // 特殊处理 markdown 语言的代码块：解包并递归解析
    if (
      codeBlockLang?.toLowerCase() === 'markdown' ||
      codeBlockLang?.toLowerCase() === 'md'
    ) {
      const innerBlocks = parseMarkdown(codeContent);
      blocks.push(...innerBlocks);
    } else {
      blocks.push({
        type: 'code',
        content: codeContent,
        language: codeBlockLang || undefined,
      });
    }
  }

  // 处理未闭合的表格
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    blocks.push({
      type: 'table',
      content: '',
      tableData: { headers: tableHeaders, rows: tableRows },
    });
  }

  // 过滤掉末尾的空行
  while (blocks.length > 0 && blocks[blocks.length - 1].type === 'empty') {
    blocks.pop();
  }

  return blocks;
}
