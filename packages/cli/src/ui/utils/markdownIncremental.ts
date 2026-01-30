/**
 * Markdown 增量解析缓存
 *
 * 目的：
 * - 将流式增量内容分段解析为 blocks
 * - 平摊最终渲染的解析开销
 */

import {
  MARKDOWN_PATTERNS,
  type ParsedBlock,
  parseMarkdown,
} from './markdownParser.js';

interface IncrementalState {
  inCodeBlock: boolean;
  codeBlockContent: string[];
  codeBlockLang: string | null;
  codeBlockDepth: number;
  inTable: boolean;
  tableHeaders: string[];
  tableRows: string[][];
  inDiff: boolean;
  diffContent: string[];
  lastLineEmpty: boolean;
  pendingTableHeader: string | null;
}

interface CacheEntry {
  state: IncrementalState;
  blocks: ParsedBlock[];
  pendingLine: string;
  finalized: boolean;
}

const cache = new Map<string, CacheEntry>();

function createState(): IncrementalState {
  return {
    inCodeBlock: false,
    codeBlockContent: [],
    codeBlockLang: null,
    codeBlockDepth: 0,
    inTable: false,
    tableHeaders: [],
    tableRows: [],
    inDiff: false,
    diffContent: [],
    lastLineEmpty: true,
    pendingTableHeader: null,
  };
}

function getEntry(messageId: string): CacheEntry {
  const existing = cache.get(messageId);
  if (existing) return existing;
  const entry: CacheEntry = {
    state: createState(),
    blocks: [],
    pendingLine: '',
    finalized: false,
  };
  cache.set(messageId, entry);
  return entry;
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function closeOpenTable(state: IncrementalState, blocks: ParsedBlock[]): void {
  if (state.tableHeaders.length > 0 && state.tableRows.length > 0) {
    blocks.push({
      type: 'table',
      content: '',
      tableData: { headers: state.tableHeaders, rows: state.tableRows },
    });
  }
  state.inTable = false;
  state.tableHeaders = [];
  state.tableRows = [];
}

function closeOpenCodeBlock(state: IncrementalState, blocks: ParsedBlock[]): void {
  const codeContent = state.codeBlockContent.join('\n');
  if (
    state.codeBlockLang?.toLowerCase() === 'markdown' ||
    state.codeBlockLang?.toLowerCase() === 'md'
  ) {
    blocks.push(...parseMarkdown(codeContent));
  } else {
    blocks.push({
      type: 'code',
      content: codeContent,
      language: state.codeBlockLang || undefined,
    });
  }

  state.inCodeBlock = false;
  state.codeBlockContent = [];
  state.codeBlockLang = null;
  state.codeBlockDepth = 0;
  state.lastLineEmpty = false;
}

function processLine(line: string, entry: CacheEntry, allowReprocess: boolean = true) {
  const state = entry.state;
  const blocks = entry.blocks;

  // 处理 table 头的延迟确认
  if (state.pendingTableHeader !== null) {
    if (line.match(MARKDOWN_PATTERNS.tableSeparator)) {
      state.inTable = true;
      state.tableHeaders = state.pendingTableHeader
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      state.tableRows = [];
      state.pendingTableHeader = null;
      state.lastLineEmpty = false;
      return;
    }

    blocks.push({
      type: 'text',
      content: state.pendingTableHeader,
    });
    state.pendingTableHeader = null;
    state.lastLineEmpty = false;
  }

  // Diff 块处理
  if (state.inDiff) {
    if (line.match(MARKDOWN_PATTERNS.diffEnd)) {
      try {
        const diffJson = JSON.parse(state.diffContent.join('\n'));
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
        blocks.push({
          type: 'text',
          content: state.diffContent.join('\n'),
        });
      }
      state.inDiff = false;
      state.diffContent = [];
      state.lastLineEmpty = false;
      return;
    }
    state.diffContent.push(line);
    return;
  }

  // 检查 Diff 块开始
  if (line.match(MARKDOWN_PATTERNS.diffStart)) {
    state.inDiff = true;
    state.diffContent = [];
    state.lastLineEmpty = false;
    return;
  }

  // 代码块处理（支持嵌套）
  if (state.inCodeBlock) {
    const codeBlockStartMatch = line.match(MARKDOWN_PATTERNS.codeBlock);
    const isCodeBlockEnd = line.trim() === '```';

    if (codeBlockStartMatch && codeBlockStartMatch[1]) {
      state.codeBlockDepth++;
      state.codeBlockContent.push(line);
    } else if (isCodeBlockEnd) {
      if (state.codeBlockDepth > 0) {
        state.codeBlockDepth--;
        state.codeBlockContent.push(line);
      } else {
        closeOpenCodeBlock(state, blocks);
      }
    } else {
      state.codeBlockContent.push(line);
    }
    return;
  }

  // 检查代码块开始
  const codeBlockMatch = line.match(MARKDOWN_PATTERNS.codeBlock);
  if (codeBlockMatch) {
    state.inCodeBlock = true;
    state.codeBlockLang = codeBlockMatch[1] || null;
    state.codeBlockDepth = 0;
    state.lastLineEmpty = false;
    return;
  }

  // 表格处理
  const tableMatch = line.match(MARKDOWN_PATTERNS.table);
  const tableSepMatch = line.match(MARKDOWN_PATTERNS.tableSeparator);

  if (tableMatch && !state.inTable) {
    state.pendingTableHeader = line;
    return;
  }

  if (state.inTable && tableSepMatch) {
    return;
  }

  if (state.inTable && tableMatch) {
    const cells = tableMatch[1]
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    while (cells.length < state.tableHeaders.length) {
      cells.push('');
    }
    if (cells.length > state.tableHeaders.length) {
      cells.length = state.tableHeaders.length;
    }

    state.tableRows.push(cells);
    return;
  }

  if (state.inTable && !tableMatch) {
    closeOpenTable(state, blocks);
    if (allowReprocess) {
      processLine(line, entry, false);
      return;
    }
  }

  // 标题
  const headingMatch = line.match(MARKDOWN_PATTERNS.heading);
  if (headingMatch) {
    blocks.push({
      type: 'heading',
      content: headingMatch[2],
      level: headingMatch[1].length,
    });
    state.lastLineEmpty = false;
    return;
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
    state.lastLineEmpty = false;
    return;
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
    state.lastLineEmpty = false;
    return;
  }

  // 水平线
  const hrMatch = line.match(MARKDOWN_PATTERNS.hr);
  if (hrMatch) {
    blocks.push({
      type: 'hr',
      content: '',
    });
    state.lastLineEmpty = false;
    return;
  }

  // 空行
  if (line.trim().length === 0) {
    if (!state.lastLineEmpty) {
      blocks.push({
        type: 'empty',
        content: '',
      });
      state.lastLineEmpty = true;
    }
    return;
  }

  // <command-message> 标签
  const commandMessageMatch = line.match(MARKDOWN_PATTERNS.commandMessage);
  if (commandMessageMatch) {
    blocks.push({
      type: 'command-message',
      content: commandMessageMatch[1],
    });
    state.lastLineEmpty = false;
    return;
  }

  // 普通文本
  blocks.push({
    type: 'text',
    content: line,
  });
  state.lastLineEmpty = false;
}

export function appendMarkdownDelta(messageId: string, delta: string): void {
  if (!messageId || !delta) return;
  const entry = getEntry(messageId);
  if (entry.finalized) return;

  const combined = entry.pendingLine + delta;
  const parts = combined.split('\n');
  const endsWithNewline = combined.endsWith('\n');
  const completeLines = endsWithNewline ? parts : parts.slice(0, -1);
  entry.pendingLine = endsWithNewline ? '' : (parts[parts.length - 1] ?? '');

  for (const rawLine of completeLines) {
    processLine(normalizeLine(rawLine), entry);
  }
}

export function finalizeMarkdownCache(messageId: string): void {
  const entry = cache.get(messageId);
  if (!entry || entry.finalized) return;

  if (entry.pendingLine) {
    processLine(normalizeLine(entry.pendingLine), entry);
    entry.pendingLine = '';
  }

  if (entry.state.pendingTableHeader !== null) {
    entry.blocks.push({
      type: 'text',
      content: entry.state.pendingTableHeader,
    });
    entry.state.pendingTableHeader = null;
  }

  if (entry.state.inCodeBlock) {
    closeOpenCodeBlock(entry.state, entry.blocks);
  }

  if (entry.state.inTable) {
    closeOpenTable(entry.state, entry.blocks);
  }

  if (entry.state.inDiff) {
    entry.blocks.push({
      type: 'text',
      content: entry.state.diffContent.join('\n'),
    });
    entry.state.inDiff = false;
    entry.state.diffContent = [];
  }

  while (
    entry.blocks.length > 0 &&
    entry.blocks[entry.blocks.length - 1].type === 'empty'
  ) {
    entry.blocks.pop();
  }

  entry.finalized = true;
}

export function getMarkdownBlocks(messageId: string): ParsedBlock[] | null {
  const entry = cache.get(messageId);
  if (!entry || !entry.finalized) return null;
  return entry.blocks;
}

export function getMarkdownBlocksSnapshot(messageId: string): ParsedBlock[] | null {
  const entry = cache.get(messageId);
  if (!entry) return null;
  return entry.blocks;
}

function getMarkdownTailLines(messageId: string): string[] | null {
  const entry = cache.get(messageId);
  if (!entry) return null;

  const lines: string[] = [];
  const state = entry.state;

  if (state.inDiff) {
    lines.push('<<<DIFF>>>');
    lines.push(...state.diffContent);
  } else if (state.inCodeBlock) {
    const fence = state.codeBlockLang ? `\`\`\`${state.codeBlockLang}` : '```';
    lines.push(fence);
    lines.push(...state.codeBlockContent);
  } else if (state.inTable) {
    if (state.tableHeaders.length > 0) {
      lines.push(`| ${state.tableHeaders.join(' | ')} |`);
      lines.push(`| ${state.tableHeaders.map(() => '---').join(' | ')} |`);
      for (const row of state.tableRows) {
        lines.push(`| ${row.join(' | ')} |`);
      }
    }
  } else if (state.pendingTableHeader) {
    lines.push(state.pendingTableHeader);
  }

  if (entry.pendingLine) {
    lines.push(entry.pendingLine);
  }

  return lines.length > 0 ? lines : null;
}

export type StreamingTailMode = 'text' | 'code' | 'diff' | 'table';

export function getMarkdownTailSnapshot(
  messageId: string
): { lines: string[]; mode: StreamingTailMode } | null {
  const entry = cache.get(messageId);
  if (!entry) return null;

  let mode: StreamingTailMode = 'text';
  if (entry.state.inDiff) {
    mode = 'diff';
  } else if (entry.state.inCodeBlock) {
    mode = 'code';
  } else if (entry.state.inTable || entry.state.pendingTableHeader) {
    mode = 'table';
  }

  const lines = getMarkdownTailLines(messageId);
  if (!lines || lines.length === 0) return null;
  return { lines, mode };
}

export function clearMarkdownCache(messageId: string): void {
  cache.delete(messageId);
}

export function clearAllMarkdownCache(): void {
  cache.clear();
}
