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
import React, { useEffect, useMemo, useRef } from 'react';
import { useTheme } from '../../store/selectors/index.js';
import type { MessageRole } from '../../store/types.js';
import { clearMarkdownCache, getMarkdownBlocks } from '../utils/markdownIncremental.js';
import {
  MARKDOWN_PATTERNS,
  type ParsedBlock,
  parseMarkdown,
} from '../utils/markdownParser.js';
import { CodeHighlighter } from './CodeHighlighter.js';
import { DiffRenderer } from './DiffRenderer.js';
import { InlineRenderer } from './InlineRenderer.js';
import { ListItem } from './ListItem.js';
import { TableRenderer } from './TableRenderer.js';

interface MessageRendererProps {
  content: string;
  role: MessageRole;
  terminalWidth: number;
  metadata?: Record<string, unknown>;
  isPending?: boolean;
  availableTerminalHeight?: number;
  hidePrefix?: boolean;
  noMargin?: boolean;
  renderPlainTextOnly?: boolean;
  streamingLines?: string[];
  streamingHiddenLines?: number;
  messageId?: string;
  blocksOverride?: ParsedBlock[];
  currentLineOverride?: string;
  streamingMode?: 'text' | 'code' | 'diff' | 'table';
  renderCodeBlocksAsPlainText?: boolean;
}

// 获取角色样式配置（接受 theme 参数，从 Store 获取）
const getRoleStyle = (
  role: MessageRole,
  colors: ReturnType<typeof useTheme>['colors'],
  metadata?: Record<string, unknown>
) => {
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

/**
 * 渲染代码块
 *
 */
const CodeBlock: React.FC<{
  content: string;
  language?: string;
  terminalWidth: number;
  isPending?: boolean;
  availableHeight?: number;
}> = React.memo(
  ({ content, language, terminalWidth, isPending = false, availableHeight }) => {
    const theme = useTheme();

    // 流式模式下限制代码块高度
    if (isPending && availableHeight !== undefined) {
      const lines = content.split('\n');
      const RESERVED_LINES = 4; // 预留行数（边框、提示等）
      const maxLines = Math.max(1, availableHeight - RESERVED_LINES);

      if (lines.length > maxLines) {
        // 截断并显示提示
        const truncatedContent = lines.slice(0, maxLines).join('\n');
        return (
          <Box flexDirection="column" flexShrink={0}>
            <CodeHighlighter
              content={truncatedContent}
              language={language}
              showLineNumbers={true}
              terminalWidth={terminalWidth}
            />
            <Text color={theme.colors.text.muted} dimColor>
              ... generating more code ...
            </Text>
          </Box>
        );
      }
    }

    return (
      <CodeHighlighter
        content={content}
        language={language}
        showLineNumbers={true}
        terminalWidth={terminalWidth}
      />
    );
  }
);

/**
 * 渲染标题
 */
const Heading: React.FC<{
  content: string;
  level: number;
}> = React.memo(({ content, level }) => {
  const theme = useTheme();

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
});

/**
 * 渲染水平线
 */
const HorizontalRule: React.FC<{ terminalWidth: number }> = React.memo(
  ({ terminalWidth }) => {
    const theme = useTheme();
    const lineWidth = Math.max(0, Math.min(terminalWidth - 4, 80));
    return (
      <Text dimColor color={theme.colors.text.muted}>
        {'─'.repeat(lineWidth)}
      </Text>
    );
  }
);

/**
 * 渲染普通文本
 */
const TextBlock: React.FC<{ content: string }> = React.memo(({ content }) => {
  return (
    <Text wrap="wrap">
      <InlineRenderer text={content} />
    </Text>
  );
});

/**
 * 渲染 <command-message> 标签
 * 显示为带图标的状态消息
 */
const CommandMessage: React.FC<{ content: string }> = React.memo(({ content }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={theme.colors.info}>⏳</Text>
      <Text color={theme.colors.text.muted} italic>
        {content}
      </Text>
    </Box>
  );
});

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
  const theme = useTheme();
  const MAX_LINES = 50; // 最大显示行数

  // 过滤掉开头和结尾的空行
  const lines = detail.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

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
 * 截断内容以适应可用终端高度
 *
 * 只在 pending 状态下截断，避免流式输出时内容超过终端高度导致闪烁
 *
 * 🆕 优化：使用字符级快速截断，避免遍历所有行
 * - 直接从末尾截取估算的字符数
 * - 大幅减少长内容的计算开销
 */
function truncateContentForHeight(
  content: string,
  availableHeight: number | undefined,
  isPending: boolean,
  terminalWidth: number = 80
): { content: string; isTruncated: boolean; hiddenLines: number } {
  // 非 pending 状态或没有高度限制，不截断
  if (!isPending || availableHeight === undefined || availableHeight <= 0) {
    return { content, isTruncated: false, hiddenLines: 0 };
  }

  // 预留几行给截断提示、前缀和其他 UI 元素
  const RESERVED_LINES = 8;
  const maxDisplayLines = Math.max(1, availableHeight - RESERVED_LINES);

  // 🆕 快速路径：估算最大字符数，直接从末尾截取
  // 假设每行平均 terminalWidth * 0.8 个字符（考虑换行和短行）
  const avgCharsPerLine = Math.max(40, terminalWidth * 0.8);
  const estimatedMaxChars = maxDisplayLines * avgCharsPerLine;

  // 如果内容长度在估算范围内，不需要截断
  if (content.length <= estimatedMaxChars) {
    return { content, isTruncated: false, hiddenLines: 0 };
  }

  // 从末尾截取，多留一些余量确保不超过显示区域
  const safeMaxChars = Math.floor(estimatedMaxChars * 0.9);
  const startIndex = content.length - safeMaxChars;

  // 找到最近的换行符，确保从完整行开始
  let adjustedStartIndex = startIndex;
  const nextNewline = content.indexOf('\n', startIndex);
  if (nextNewline !== -1 && nextNewline - startIndex < avgCharsPerLine) {
    adjustedStartIndex = nextNewline + 1;
  }

  const visibleContent = content.slice(adjustedStartIndex);
  const hiddenContent = content.slice(0, adjustedStartIndex);
  const hiddenLines = (hiddenContent.match(/\n/g) || []).length + 1;

  return {
    content: visibleContent,
    isTruncated: true,
    hiddenLines,
  };
}

/**
 * 主要的消息渲染器组件
 */
export const MessageRenderer: React.FC<MessageRendererProps> = React.memo(
  ({
    content,
    role,
    terminalWidth,
    metadata,
    isPending = false,
    availableTerminalHeight,
    hidePrefix = false,
    noMargin = false,
    renderPlainTextOnly = false,
    streamingLines,
    streamingHiddenLines,
    messageId,
    blocksOverride,
    currentLineOverride,
    streamingMode = 'text',
    renderCodeBlocksAsPlainText = false,
  }) => {
    // 从 Store 获取主题（响应式）
    const theme = useTheme();
    const usingBlocksOverride = blocksOverride !== undefined;

    // 使用 useMemo 缓存角色样式计算
    const roleStyle = useMemo(
      () => getRoleStyle(role, theme.colors, metadata),
      [role, theme.colors, metadata]
    );
    const { color, prefix } = roleStyle;
    const prefixIndent = prefix.length + 1;

    // 决定是否需要底部间距：
    // - tool 消息的 'start' 阶段不需要（等待结果）
    // - tool 消息的 'complete' 阶段需要（工具调用结束）
    // - 其他消息需要
    const isToolStart = role === 'tool' && metadata?.phase === 'start';
    const shouldHaveMargin = !noMargin && !isToolStart;

    const plainTextLines = useMemo(() => {
      if (!renderPlainTextOnly) return [];
      return content.split(/\r?\n/);
    }, [content, renderPlainTextOnly]);

    if (!usingBlocksOverride && isPending) {
      const pendingLines = streamingLines ?? content.split(/\r?\n/);
      const hiddenLines = streamingHiddenLines ?? 0;
      let inCodeBlock = false;
      let inDiff = false;
      let inTable = false;
      if (streamingMode !== 'text') {
        inCodeBlock = streamingMode === 'code';
        inDiff = streamingMode === 'diff';
        inTable = streamingMode === 'table';
      }
      return (
        <Box
          flexDirection="column"
          marginBottom={shouldHaveMargin ? 1 : 0}
          flexShrink={0}
        >
          {hiddenLines > 0 && (
            <Box flexDirection="row" flexShrink={0}>
              <Box width={prefixIndent} flexShrink={0} />
              <Text color={theme.colors.text.muted} dimColor>
                ↑ {hiddenLines} lines above (streaming...)
              </Text>
            </Box>
          )}
          {pendingLines.map((line, index) => {
            if (streamingMode === 'text') {
              if (line.match(MARKDOWN_PATTERNS.codeBlock)) {
                inCodeBlock = !inCodeBlock;
              } else if (line.match(MARKDOWN_PATTERNS.diffStart)) {
                inDiff = true;
              } else if (line.match(MARKDOWN_PATTERNS.diffEnd)) {
                inDiff = false;
              } else if (line.match(MARKDOWN_PATTERNS.table)) {
                inTable = true;
              } else if (inTable && !line.match(MARKDOWN_PATTERNS.table)) {
                inTable = false;
              }
            }

            const canParseList =
              streamingMode === 'text' && !inCodeBlock && !inDiff && !inTable;
            const ulMatch = canParseList ? line.match(MARKDOWN_PATTERNS.ulItem) : null;
            const olMatch = canParseList ? line.match(MARKDOWN_PATTERNS.olItem) : null;
            const listMatch = ulMatch ?? olMatch;

            return (
              <Box key={index} flexDirection="row" flexShrink={0}>
                {index === 0 && !hidePrefix ? (
                  <Box marginRight={1} flexShrink={0}>
                    <Text color={color} bold>
                      {prefix}
                    </Text>
                  </Box>
                ) : (
                  <Box width={prefixIndent} flexShrink={0} />
                )}
                <Box flexGrow={1} flexShrink={0}>
                  {listMatch ? (
                    <ListItem
                      type={ulMatch ? 'ul' : 'ol'}
                      marker={listMatch[2]}
                      itemText={listMatch[3]}
                      leadingWhitespace={listMatch[1]}
                    />
                  ) : (
                    <Text wrap="wrap">{line === '' ? ' ' : line}</Text>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }

    if (!usingBlocksOverride && renderPlainTextOnly) {
      return (
        <Box
          flexDirection="column"
          marginBottom={shouldHaveMargin ? 1 : 0}
          flexShrink={0}
        >
          {plainTextLines.map((line, index) => (
            <Box key={index} flexDirection="row" flexShrink={0}>
              {index === 0 && !hidePrefix ? (
                <Box marginRight={1} flexShrink={0}>
                  <Text color={color} bold>
                    {prefix}
                  </Text>
                </Box>
              ) : (
                <Box width={prefixIndent} flexShrink={0} />
              )}
              <Box flexGrow={1} flexShrink={0}>
                <Text wrap="wrap">{line === '' ? ' ' : line}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
    }

    const cachedBlocksRef = useRef<{ messageId: string; blocks: ParsedBlock[] } | null>(
      null
    );
    useEffect(() => {
      cachedBlocksRef.current = null;
    }, [messageId]);

    const cachedBlocks = useMemo(() => {
      if (usingBlocksOverride) return null;
      if (!messageId) return null;
      return getMarkdownBlocks(messageId);
    }, [messageId, usingBlocksOverride]);

    useEffect(() => {
      if (usingBlocksOverride) return;
      if (!cachedBlocks || !messageId) return;
      cachedBlocksRef.current = { messageId, blocks: cachedBlocks };
    }, [cachedBlocks, messageId, usingBlocksOverride]);

    useEffect(() => {
      if (usingBlocksOverride) return;
      if (!cachedBlocks || !messageId) return;
      clearMarkdownCache(messageId);
    }, [cachedBlocks, messageId, usingBlocksOverride]);

    // 在非流式状态下截断内容（考虑终端宽度导致的自动换行）
    const truncatedResult = useMemo(
      () =>
        usingBlocksOverride
          ? { content, isTruncated: false, hiddenLines: 0 }
          : truncateContentForHeight(
              content,
              availableTerminalHeight,
              isPending,
              terminalWidth
            ),
      [content, availableTerminalHeight, isPending, terminalWidth, usingBlocksOverride]
    );
    const { content: displayContent, isTruncated, hiddenLines } = truncatedResult;

    // 处理 tool 消息的详细内容（complete 阶段）
    if (!usingBlocksOverride && role === 'tool' && metadata && 'detail' in metadata) {
      const toolMetadata = metadata as { detail?: string; phase?: string };
      if (toolMetadata.detail) {
        return (
          <Box flexDirection="column" marginBottom={noMargin ? 0 : 1}>
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
            <Box marginLeft={prefix.length + 1}>
              <ToolDetailRenderer
                detail={toolMetadata.detail}
                terminalWidth={terminalWidth - (prefix.length + 1)}
              />
            </Box>
          </Box>
        );
      }
    }

    // 流式模式优化：分离已完成行和当前行
    // - 只对已完成行做 Markdown 解析（结构稳定）
    // - 当前行作为纯文本追加（避免未闭合结构导致的解析问题）
    const { completedContent, currentLine } = useMemo(() => {
      if (usingBlocksOverride) {
        return {
          completedContent: '',
          currentLine: currentLineOverride ?? '',
        };
      }
      if (!isPending) {
        return { completedContent: displayContent, currentLine: '' };
      }
      const lastNewlineIndex = displayContent.lastIndexOf('\n');
      if (lastNewlineIndex === -1) {
        // 没有换行符，全部作为当前行
        return { completedContent: '', currentLine: displayContent };
      }
      return {
        completedContent: displayContent.slice(0, lastNewlineIndex + 1),
        currentLine: displayContent.slice(lastNewlineIndex + 1),
      };
    }, [displayContent, isPending, usingBlocksOverride, currentLineOverride]);

    // 增量解析优化：使用 ref 缓存已解析的 blocks，只在 completedContent 增长时追加解析
    const blocksRef = useRef<{ content: string; blocks: ParsedBlock[] }>({
      content: '',
      blocks: [],
    });

    const blocks = useMemo(() => {
      if (usingBlocksOverride) {
        return blocksOverride ?? [];
      }
      if (cachedBlocks) {
        return cachedBlocks;
      }
      if (cachedBlocksRef.current && cachedBlocksRef.current.messageId === messageId) {
        return cachedBlocksRef.current.blocks;
      }
      const cached = blocksRef.current;

      // 非 pending 模式或内容完全变化，重新解析
      if (!isPending || !completedContent.startsWith(cached.content)) {
        const newBlocks = parseMarkdown(completedContent);
        blocksRef.current = { content: completedContent, blocks: newBlocks };
        return newBlocks;
      }

      // 内容没有增长，复用缓存
      if (completedContent === cached.content) {
        return cached.blocks;
      }

      // 增量解析：只解析新增的部分
      const newContent = completedContent.slice(cached.content.length);
      const newBlocks = parseMarkdown(newContent);

      // 合并 blocks（注意：这里简化处理，实际可能需要更复杂的合并逻辑）
      const mergedBlocks = [...cached.blocks, ...newBlocks];
      blocksRef.current = { content: completedContent, blocks: mergedBlocks };
      return mergedBlocks;
    }, [completedContent, isPending, usingBlocksOverride, blocksOverride]);
    return (
      <Box
        flexDirection="column"
        marginBottom={shouldHaveMargin ? 1 : 0}
        flexShrink={0}
      >
        {isTruncated && (
          <Box flexDirection="row" flexShrink={0}>
            <Box width={prefixIndent} flexShrink={0} />
            <Text color={theme.colors.text.muted} dimColor>
              ↑ {hiddenLines} lines above (streaming...)
            </Text>
          </Box>
        )}
        {blocks.map((block, index) => {
          if (block.type === 'empty') {
            return <Box key={index} height={1} flexShrink={0} />;
          }

          return (
            <Box key={index} flexDirection="row" flexShrink={0}>
              {index === 0 && !hidePrefix && (
                <Box marginRight={1} flexShrink={0}>
                  <Text color={color} bold>
                    {prefix}
                  </Text>
                </Box>
              )}

              {(index > 0 || hidePrefix) && <Box width={prefixIndent} flexShrink={0} />}

              <Box flexGrow={1} flexShrink={0}>
                {block.type === 'code' ? (
                  renderCodeBlocksAsPlainText ? (
                    <Text wrap="wrap">{block.content}</Text>
                  ) : (
                    <CodeBlock
                      content={block.content}
                      language={block.language}
                      terminalWidth={terminalWidth - prefixIndent}
                      isPending={isPending}
                      availableHeight={availableTerminalHeight}
                    />
                  )
                ) : block.type === 'table' && block.tableData ? (
                  <TableRenderer
                    headers={block.tableData.headers}
                    rows={block.tableData.rows}
                    terminalWidth={terminalWidth - prefixIndent}
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
                  <HorizontalRule terminalWidth={terminalWidth - prefixIndent} />
                ) : block.type === 'diff' && block.diffData ? (
                  <DiffRenderer
                    patch={block.diffData.patch}
                    startLine={block.diffData.startLine}
                    matchLine={block.diffData.matchLine}
                    terminalWidth={terminalWidth - prefixIndent}
                  />
                ) : block.type === 'command-message' ? (
                  <CommandMessage content={block.content} />
                ) : (
                  <TextBlock content={block.content} />
                )}
              </Box>
            </Box>
          );
        })}
        {/* 流式模式：渲染当前行（纯文本，避免未闭合结构的解析问题） */}
        {currentLine && (
          <Box flexDirection="row" flexShrink={0}>
            {blocks.length === 0 && !hidePrefix ? (
              <Box marginRight={1} flexShrink={0}>
                <Text color={color} bold>
                  {prefix}
                </Text>
              </Box>
            ) : (
              <Box width={prefixIndent} flexShrink={0} />
            )}
            <Box flexGrow={1} flexShrink={0}>
              <Text wrap="wrap">{currentLine}</Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.content === nextProps.content &&
      prevProps.role === nextProps.role &&
      prevProps.terminalWidth === nextProps.terminalWidth &&
      prevProps.isPending === nextProps.isPending &&
      prevProps.availableTerminalHeight === nextProps.availableTerminalHeight &&
      prevProps.hidePrefix === nextProps.hidePrefix &&
      prevProps.noMargin === nextProps.noMargin &&
      prevProps.renderPlainTextOnly === nextProps.renderPlainTextOnly &&
      prevProps.streamingHiddenLines === nextProps.streamingHiddenLines &&
      prevProps.streamingLines === nextProps.streamingLines &&
      prevProps.messageId === nextProps.messageId &&
      prevProps.metadata === nextProps.metadata &&
      prevProps.blocksOverride === nextProps.blocksOverride &&
      prevProps.currentLineOverride === nextProps.currentLineOverride &&
      prevProps.streamingMode === nextProps.streamingMode &&
      prevProps.renderCodeBlocksAsPlainText === nextProps.renderCodeBlocksAsPlainText
    );
  }
);
