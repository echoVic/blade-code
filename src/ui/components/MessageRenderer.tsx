/**
 * 消息渲染器 - 完整的 Markdown 格式化支持
 *
 * 支持的 Markdown 特性：
 * - 代码块（语法高亮）
 * - 表格
 * - 标题（H1-H4）
 * - 列表（有序/无序，支持嵌套）
 * - 水平线
 * - 内联格式（粗体、斜体、删除线、内联代码、链接）
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { MessageRole } from '../contexts/SessionContext.js';
import { themeManager } from '../themes/ThemeManager.js';
import { CodeHighlighter } from './CodeHighlighter.js';
import { DiffRenderer } from './DiffRenderer.js';
import { InlineRenderer } from './InlineRenderer.js';
import { ListItem } from './ListItem.js';
import { TableRenderer } from './TableRenderer.js';

export interface MessageRendererProps {
  content: string;
  role: MessageRole;
  terminalWidth: number;
  metadata?: Record<string, unknown>; // 🆕 用于 tool-progress 等消息的元数据
}

// 获取角色样式配置
const getRoleStyle = (role: MessageRole, metadata?: Record<string, unknown>) => {
  const theme = themeManager.getTheme();
  const colors = theme.colors;

  switch (role) {
    case 'user':
      return { color: colors.info, prefix: '> ' };
    case 'assistant':
      return { color: colors.success, prefix: '• ' };
    case 'system':
      return { color: colors.warning, prefix: '⚙ ' };
    case 'tool': {
      // 根据 phase 控制前缀（流式显示风格）
      const phase =
        metadata && 'phase' in metadata ? (metadata.phase as string) : undefined;
      return {
        color: colors.text.secondary,
        prefix: phase === 'start' ? '• ' : phase === 'complete' ? '  └ ' : '  ',
      };
    }
    default:
      // 未知角色，使用默认样式
      return { color: colors.text.primary, prefix: '  ' };
  }
};

// Markdown 解析正则表达式
const MARKDOWN_PATTERNS = {
  codeBlock: /^```(\w+)?\s*$/,
  heading: /^ *(#{1,4}) +(.+)/,
  ulItem: /^([ \t]*)([-*+]) +(.+)/,
  olItem: /^([ \t]*)(\d+)\. +(.+)/,
  hr: /^ *([-*_] *){3,} *$/,
  table: /^\|(.+)\|$/,
  tableSeparator: /^\|[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)+\|?$/,
  diffStart: /^<<<DIFF>>>$/,
  diffEnd: /^<<<\/DIFF>>>$/,
} as const;

interface ParsedBlock {
  type: 'text' | 'code' | 'heading' | 'table' | 'list' | 'hr' | 'empty' | 'diff';
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
 */
function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = content.split(/\r?\n/);

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;

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

    // 代码块处理
    if (inCodeBlock) {
      const codeBlockMatch = line.match(MARKDOWN_PATTERNS.codeBlock);
      if (codeBlockMatch) {
        // 代码块结束
        blocks.push({
          type: 'code',
          content: codeBlockContent.join('\n'),
          language: codeBlockLang || undefined,
        });
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        lastLineEmpty = false;
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

    // 普通文本
    blocks.push({
      type: 'text',
      content: line,
    });
    lastLineEmpty = false;
  }

  // 处理未闭合的代码块
  if (inCodeBlock) {
    blocks.push({
      type: 'code',
      content: codeBlockContent.join('\n'),
      language: codeBlockLang || undefined,
    });
  }

  // 处理未闭合的表格
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    blocks.push({
      type: 'table',
      content: '',
      tableData: { headers: tableHeaders, rows: tableRows },
    });
  }

  return blocks;
}

/**
 * 渲染代码块
 */
const CodeBlock: React.FC<{
  content: string;
  language?: string;
  terminalWidth: number;
}> = ({ content, language, terminalWidth }) => {
  return (
    <CodeHighlighter
      content={content}
      language={language}
      showLineNumbers={true}
      terminalWidth={terminalWidth}
    />
  );
};

/**
 * 渲染标题
 */
const Heading: React.FC<{
  content: string;
  level: number;
}> = ({ content, level }) => {
  const theme = themeManager.getTheme();

  // 根据级别设置样式
  switch (level) {
    case 1: // # H1
      return (
        <Text bold color={theme.colors.primary}>
          <InlineRenderer text={content} />
        </Text>
      );
    case 2: // ## H2
      return (
        <Text bold color={theme.colors.primary}>
          <InlineRenderer text={content} />
        </Text>
      );
    case 3: // ### H3
      return (
        <Text bold color={theme.colors.text.primary}>
          <InlineRenderer text={content} />
        </Text>
      );
    case 4: // #### H4
      return (
        <Text italic color={theme.colors.text.muted}>
          <InlineRenderer text={content} />
        </Text>
      );
    default:
      return (
        <Text>
          <InlineRenderer text={content} />
        </Text>
      );
  }
};

/**
 * 渲染水平线
 */
const HorizontalRule: React.FC<{ terminalWidth: number }> = ({ terminalWidth }) => {
  const theme = themeManager.getTheme();
  const lineWidth = Math.min(terminalWidth - 4, 80);
  return (
    <Text dimColor color={theme.colors.text.muted}>
      {'─'.repeat(lineWidth)}
    </Text>
  );
};

/**
 * 渲染普通文本
 */
const TextBlock: React.FC<{ content: string }> = ({ content }) => {
  return (
    <Text wrap="wrap">
      <InlineRenderer text={content} />
    </Text>
  );
};

/**
 * 工具详细内容渲染器（优化版）
 *
 * 优化策略：
 * 1. 只支持代码块和 diff（简化 Markdown）
 * 2. 限制最大行数（避免过大的组件树）
 * 3. 使用 memo 优化（避免不必要的重渲染）
 */
const ToolDetailRenderer: React.FC<{
  detail: string;
  terminalWidth: number;
}> = React.memo(({ detail, terminalWidth }) => {
  const theme = themeManager.getTheme();
  const MAX_LINES = 50; // 最大显示行数
  const lines = detail.split('\n');

  // 限制行数，超过部分显示省略提示
  const isTruncated = lines.length > MAX_LINES;
  const displayLines = isTruncated ? lines.slice(0, MAX_LINES) : lines;
  const displayContent = displayLines.join('\n');

  // 检测内容类型
  const isDiff = displayContent.includes('<<<DIFF>>>');
  const isCodeBlock = displayContent.includes('```');

  // 渲染 diff 内容
  if (isDiff) {
    const diffMatch = displayContent.match(/<<<DIFF>>>\s*({[\s\S]*?})\s*<<<\/DIFF>>>/);
    if (diffMatch) {
      try {
        const diffData = JSON.parse(diffMatch[1]);
        return (
          <Box flexDirection="column">
            <DiffRenderer
              patch={diffData.patch}
              startLine={diffData.startLine}
              matchLine={diffData.matchLine}
              terminalWidth={terminalWidth}
            />
            {isTruncated && (
              <Box marginTop={1}>
                <Text dimColor color={theme.colors.text.muted}>
                  ... 省略 {lines.length - MAX_LINES} 行 ...
                </Text>
              </Box>
            )}
          </Box>
        );
      } catch {
        // diff 解析失败，降级为纯文本
      }
    }
  }

  // 渲染代码块
  if (isCodeBlock) {
    const codeMatch = displayContent.match(/```(\w+)?\s*\n([\s\S]*?)\n```/);
    if (codeMatch) {
      const language = codeMatch[1] || 'text';
      const code = codeMatch[2];
      return (
        <Box flexDirection="column">
          <CodeHighlighter
            content={code}
            language={language}
            showLineNumbers={false}
            terminalWidth={terminalWidth}
          />
          {isTruncated && (
            <Box marginTop={1}>
              <Text dimColor color={theme.colors.text.muted}>
                ... 省略 {lines.length - MAX_LINES} 行 ...
              </Text>
            </Box>
          )}
        </Box>
      );
    }
  }

  // 降级为纯文本显示（按行渲染，避免单个巨大的 Text 组件）
  return (
    <Box flexDirection="column">
      {displayLines.map((line, index) => (
        <Text key={index} color={theme.colors.text.primary}>
          {line}
        </Text>
      ))}
      {isTruncated && (
        <Box marginTop={1}>
          <Text dimColor color={theme.colors.text.muted}>
            ... 省略 {lines.length - MAX_LINES} 行 ...
          </Text>
        </Box>
      )}
    </Box>
  );
});

/**
 * 主要的消息渲染器组件
 */
export const MessageRenderer: React.FC<MessageRendererProps> = React.memo(
  ({ content, role, terminalWidth, metadata }) => {
    const roleStyle = getRoleStyle(role, metadata);
    const { color, prefix } = roleStyle;

    // 处理 tool 消息的详细内容
    if (role === 'tool' && metadata && 'detail' in metadata) {
      const toolMetadata = metadata as { detail?: string; phase?: string };
      if (toolMetadata.detail) {
        return (
          <Box flexDirection="column" marginBottom={1}>
            {/* 摘要行 */}
            <Box flexDirection="row">
              <Box marginRight={1}>
                <Text color={color} bold>
                  {prefix}
                </Text>
              </Box>
              <Text color={color}>{content}</Text>
            </Box>

            {/* 详细内容（优化渲染） */}
            <Box marginLeft={prefix.length + 1} marginTop={1}>
              <ToolDetailRenderer
                detail={toolMetadata.detail}
                terminalWidth={terminalWidth - (prefix.length + 1)}
              />
            </Box>
          </Box>
        );
      }
    }

    // 正常渲染（摘要行或无 detail 的消息）
    const blocks = parseMarkdown(content);

    return (
      <Box flexDirection="column" marginBottom={1}>
        {blocks.map((block, index) => {
          // 空行
          if (block.type === 'empty') {
            return <Box key={index} height={1} />;
          }

          return (
            <Box key={index} flexDirection="row">
              {/* 只在第一个非空块显示前缀 */}
              {index === 0 && (
                <Box marginRight={1}>
                  <Text color={color} bold>
                    {prefix}
                  </Text>
                </Box>
              )}

              {/* 为非第一个块添加缩进对齐 */}
              {index > 0 && <Box width={prefix.length + 1} />}

              <Box flexGrow={1}>
                {block.type === 'code' ? (
                  <CodeBlock
                    content={block.content}
                    language={block.language}
                    terminalWidth={terminalWidth - (prefix.length + 1)}
                  />
                ) : block.type === 'table' && block.tableData ? (
                  <TableRenderer
                    headers={block.tableData.headers}
                    rows={block.tableData.rows}
                    terminalWidth={terminalWidth - (prefix.length + 1)}
                  />
                ) : block.type === 'heading' ? (
                  <Heading content={block.content} level={block.level || 1} />
                ) : block.type === 'list' ? (
                  <ListItem
                    type={block.listType || 'ul'}
                    marker={block.marker || '-'}
                    itemText={block.content}
                    leadingWhitespace={' '.repeat(block.indentation || 0)}
                  />
                ) : block.type === 'hr' ? (
                  <HorizontalRule terminalWidth={terminalWidth - (prefix.length + 1)} />
                ) : block.type === 'diff' && block.diffData ? (
                  <DiffRenderer
                    patch={block.diffData.patch}
                    startLine={block.diffData.startLine}
                    matchLine={block.diffData.matchLine}
                    terminalWidth={terminalWidth - (prefix.length + 1)}
                  />
                ) : (
                  <TextBlock content={block.content} />
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  }
);
