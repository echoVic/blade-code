import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('ink', () => ({
  Box: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('div', props, children),
  Text: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('span', props, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useTheme: () => ({
    colors: {
      primary: 'blue',
      success: 'green',
      warning: 'yellow',
      info: 'cyan',
      text: {
        primary: 'white',
        secondary: 'gray',
        muted: 'darkgray',
      },
    },
  }),
}));

vi.mock('../../../../src/ui/utils/markdownIncremental.js', () => ({
  clearMarkdownCache: vi.fn(),
  getMarkdownBlocks: vi.fn(() => null),
}));

vi.mock('../../../../src/ui/components/CodeHighlighter.js', () => ({
  CodeHighlighter: ({ content, language }: { content: string; language?: string }) =>
    React.createElement(
      'code-highlighter',
      { 'data-language': language ?? 'plain' },
      content
    ),
}));

vi.mock('../../../../src/ui/components/DiffRenderer.js', () => ({
  DiffRenderer: ({
    patch,
    startLine,
    matchLine,
  }: {
    patch: string;
    startLine: number;
    matchLine: number;
  }) =>
    React.createElement('diff-renderer', {
      'data-patch': patch,
      'data-start-line': String(startLine),
      'data-match-line': String(matchLine),
    }),
}));

vi.mock('../../../../src/ui/components/BlockquoteRenderer.js', () => ({
  BlockquoteRenderer: ({ lines, level }: { lines: string[]; level: number }) =>
    React.createElement(
      'blockquote-renderer',
      { 'data-level': String(level) },
      lines.join(' | ')
    ),
}));

vi.mock('../../../../src/ui/components/InlineRenderer.js', () => ({
  InlineRenderer: ({ text }: { text: string }) =>
    React.createElement('inline-renderer', { 'data-text': text }, text),
}));

vi.mock('../../../../src/ui/components/ListItem.js', () => ({
  ListItem: ({
    type,
    marker,
    itemText,
    leadingWhitespace,
  }: {
    type: string;
    marker: string;
    itemText: string;
    leadingWhitespace: string;
  }) =>
    React.createElement(
      'list-item',
      {
        'data-type': type,
        'data-marker': marker,
        'data-indent': String(leadingWhitespace.length),
      },
      itemText
    ),
}));

vi.mock('../../../../src/ui/components/TableRenderer.js', () => ({
  TableRenderer: ({ headers, rows }: { headers: string[]; rows: string[][] }) =>
    React.createElement(
      'table-renderer',
      {
        'data-headers': headers.join('|'),
        'data-rows': rows.map((row) => row.join('|')).join(';'),
      },
      null
    ),
}));

describe('MessageRenderer', () => {
  const renderMessage = async (content: string) => {
    const { MessageRenderer } = await import(
      '../../../../src/ui/components/MessageRenderer.js'
    );

    return renderToStaticMarkup(
      React.createElement(MessageRenderer, {
        content,
        role: 'assistant',
        terminalWidth: 100,
      })
    );
  };

  it('为 heading 和 nested list 提供稳定结构快照', async () => {
    const html = await renderMessage(
      [
        '## Release Plan',
        '- top item',
        '  - nested item',
        '1. first step',
        '   1. child step',
      ].join('\n')
    );

    expect(html).toMatchInlineSnapshot(
      `"<div flexDirection="column" marginBottom="1" flexShrink="0"><div flexDirection="row" flexShrink="0"><div marginRight="1" flexShrink="0"><span color="green">• </span></div><div flexGrow="1" flexShrink="0"><span color="blue"><inline-renderer data-text="Release Plan">Release Plan</inline-renderer></span></div></div><div flexDirection="row" flexShrink="0"><div width="3" flexShrink="0"></div><div flexGrow="1" flexShrink="0"><list-item data-type="ul" data-marker="-" data-indent="0">top item</list-item></div></div><div flexDirection="row" flexShrink="0"><div width="3" flexShrink="0"></div><div flexGrow="1" flexShrink="0"><list-item data-type="ul" data-marker="-" data-indent="2">nested item</list-item></div></div><div flexDirection="row" flexShrink="0"><div width="3" flexShrink="0"></div><div flexGrow="1" flexShrink="0"><list-item data-type="ol" data-marker="1" data-indent="0">first step</list-item></div></div><div flexDirection="row" flexShrink="0"><div width="3" flexShrink="0"></div><div flexGrow="1" flexShrink="0"><list-item data-type="ol" data-marker="1" data-indent="3">child step</list-item></div></div></div>"`
    );
  });

  it('覆盖 blockquote、table、diff 和 markdown fenced code', async () => {
    const html = await renderMessage(
      [
        '> quoted line',
        '> continued',
        '',
        '| Name | Status |',
        '| --- | --- |',
        '| cli | ok |',
        '',
        '<<<DIFF>>>',
        '{"patch":"@@ -1 +1 @@\\n-old\\n+new","startLine":3,"matchLine":4}',
        '<<</DIFF>>>',
        '',
        '```ts',
        'const value = 1;',
        '```',
      ].join('\n')
    );

    expect(html).toContain(
      '<blockquote-renderer data-level="1">quoted line | continued</blockquote-renderer>'
    );
    expect(html).toContain(
      '<table-renderer data-headers="Name|Status" data-rows="cli|ok"></table-renderer>'
    );
    expect(html).toContain(
      '<diff-renderer data-patch="@@ -1 +1 @@\n-old\n+new" data-start-line="3" data-match-line="4"></diff-renderer>'
    );
    expect(html).toContain(
      '<code-highlighter data-language="ts">const value = 1;</code-highlighter>'
    );
  });
});
