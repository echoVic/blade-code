/**
 * 消息渲染器 - 支持 Markdown 格式化
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../themes/types.js';
import { CodeHighlighter } from './CodeHighlighter.js';
import { TableRenderer } from './TableRenderer.js';

export interface MessageRendererProps {
  content: string;
  role: 'user' | 'assistant';
  terminalWidth: number;
  theme?: Theme;
}

// 基础 Markdown 解析正则表达式
const MARKDOWN_PATTERNS = {
  codeBlock: /^```(\w+)?\s*\n([\s\S]*?)\n```$/gm,
  inlineCode: /`([^`]+)`/g,
  heading: /^(#{1,4})\s+(.+)$/gm,
  bold: /\*\*([^*]+)\*\*/g,
  italic: /\*([^*]+)\*/g,
  listItem: /^[-*+]\s+(.+)$/gm,
  table: /^\|(.+)\|$/gm,
  tableSeparator: /^\|[\s]*:?-+:?[\s]*\|/,
} as const;

interface ParsedBlock {
  type: 'text' | 'code' | 'heading' | 'table';
  content: string;
  language?: string;
  level?: number;
  tableData?: {
    headers: string[];
    rows: string[][];
  };
}

/**
 * 解析 Markdown 内容为结构化块
 */
function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let remainingContent = content;

  // 先处理代码块
  const codeBlockMatches = Array.from(remainingContent.matchAll(MARKDOWN_PATTERNS.codeBlock));
  
  if (codeBlockMatches.length > 0) {
    let lastIndex = 0;
    
    for (const match of codeBlockMatches) {
      const [fullMatch, language = '', code] = match;
      const matchStart = match.index || 0;
      
      // 添加代码块前的文本
      if (matchStart > lastIndex) {
        const textContent = remainingContent.slice(lastIndex, matchStart).trim();
        if (textContent) {
          // 检查文本中是否包含表格
          const textBlocks = parseTextForTables(textContent);
          blocks.push(...textBlocks);
        }
      }
      
      // 添加代码块
      blocks.push({
        type: 'code',
        content: code.trim(),
        language: language || undefined
      });
      
      lastIndex = matchStart + fullMatch.length;
    }
    
    // 添加最后剩余的文本
    if (lastIndex < remainingContent.length) {
      const textContent = remainingContent.slice(lastIndex).trim();
      if (textContent) {
        const textBlocks = parseTextForTables(textContent);
        blocks.push(...textBlocks);
      }
    }
  } else {
    // 没有代码块，直接处理文本和表格
    const textBlocks = parseTextForTables(remainingContent);
    blocks.push(...textBlocks);
  }

  return blocks;
}

/**
 * 解析文本中的表格
 */
function parseTextForTables(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = text.split('\n');
  let currentTextLines: string[] = [];
  let currentTable: { headers: string[]; rows: string[][] } | null = null;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = line.match(MARKDOWN_PATTERNS.table);
    const isTableSeparator = line.match(MARKDOWN_PATTERNS.tableSeparator);

    if (isTableRow && !inTable) {
      // 检查下一行是否是分隔符
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.match(MARKDOWN_PATTERNS.tableSeparator)) {
        // 开始表格
        inTable = true;
        
        // 保存之前的文本
        if (currentTextLines.length > 0) {
          blocks.push({
            type: 'text',
            content: currentTextLines.join('\n').trim()
          });
          currentTextLines = [];
        }
        
        // 解析表头
        const headers = isTableRow[1]
          .split('|')
          .map(cell => cell.trim())
          .filter(cell => cell.length > 0);
        
        currentTable = { headers, rows: [] };
        i++; // 跳过分隔符行
        continue;
      }
    }

    if (inTable && isTableRow) {
      // 添加表格行
      const cells = isTableRow[1]
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell.length > 0);
      
      currentTable!.rows.push(cells);
    } else if (inTable && !isTableRow && !isTableSeparator) {
      // 表格结束
      if (currentTable) {
        blocks.push({
          type: 'table',
          content: '',
          tableData: currentTable
        });
      }
      inTable = false;
      currentTable = null;
      
      // 当前行作为普通文本处理
      if (line.trim()) {
        currentTextLines.push(line);
      }
    } else if (!inTable) {
      // 普通文本行
      currentTextLines.push(line);
    }
  }

  // 处理剩余内容
  if (inTable && currentTable) {
    blocks.push({
      type: 'table',
      content: '',
      tableData: currentTable
    });
  } else if (currentTextLines.length > 0) {
    blocks.push({
      type: 'text',
      content: currentTextLines.join('\n').trim()
    });
  }

  return blocks.filter(block => 
    block.type !== 'text' || (block.content && block.content.trim().length > 0)
  );
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
 * 渲染普通文本（支持内联格式）
 */
const TextBlock: React.FC<{
  content: string;
  role: 'user' | 'assistant';
}> = ({ content, role }) => {
  // 简单处理内联代码
  const renderInlineCode = (text: string) => {
    const parts = text.split(MARKDOWN_PATTERNS.inlineCode);
    const result: React.ReactNode[] = [];
    
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // 普通文本
        if (parts[i]) {
          result.push(<Text key={i}>{parts[i]}</Text>);
        }
      } else {
        // 内联代码
        result.push(
          <Text key={i} backgroundColor="gray" color="white">
            {` ${parts[i]} `}
          </Text>
        );
      }
    }
    
    return result.length > 0 ? result : [<Text key="empty">{text}</Text>];
  };

  const lines = content.split('\n');
  
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index} marginBottom={index < lines.length - 1 ? 0 : 0}>
          <Text color={role === 'user' ? 'cyan' : 'green'} wrap="wrap">
            {renderInlineCode(line)}
          </Text>
        </Box>
      ))}
    </Box>
  );
};

/**
 * 主要的消息渲染器组件
 */
export const MessageRenderer: React.FC<MessageRendererProps> = ({
  content,
  role,
  terminalWidth,
}) => {
  const blocks = parseMarkdown(content);
  const prefix = role === 'user' ? '❯ ' : '🤖 ';
  
  return (
    <Box flexDirection="column" marginBottom={1}>
      {blocks.map((block, index) => (
        <Box key={index} flexDirection="row">
          {/* 只在第一个块显示前缀 */}
          {index === 0 && (
            <Box marginRight={1}>
              <Text color={role === 'user' ? 'cyan' : 'green'} bold>
                {prefix}
              </Text>
            </Box>
          )}
          
          {/* 为非第一个块添加缩进对齐 */}
          {index > 0 && (
            <Box width={prefix.length + 1} />
          )}
          
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
            ) : (
              <TextBlock content={block.content} role={role} />
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
};