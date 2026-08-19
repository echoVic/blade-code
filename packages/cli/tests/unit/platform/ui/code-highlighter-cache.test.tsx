import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeHighlighter,
  clearCodeHighlightCache,
  getCodeHighlightCacheStats,
  HIGHLIGHT_CACHE_CAPACITY,
  HIGHLIGHT_CACHE_MAX_LINE_LENGTH,
  HIGHLIGHT_CACHE_MAX_RETAINED_CHARS,
} from '../../../../src/ui/components/CodeHighlighter.js';

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
      border: { light: 'gray' },
      text: { secondary: 'gray', muted: 'gray' },
      syntax: {
        comment: 'gray',
        string: 'green',
        number: 'magenta',
        keyword: 'blue',
        function: 'cyan',
        variable: 'white',
        operator: 'yellow',
        type: 'blue',
        tag: 'red',
        attr: 'yellow',
        default: 'white',
      },
    },
  }),
}));

vi.mock('../../../../src/ui/components/MaxSizedBox.js', () => ({
  MINIMUM_MAX_HEIGHT: 3,
  MaxSizedBox: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

function renderCode(content: string): string {
  return renderToStaticMarkup(
    <CodeHighlighter content={content} language="javascript" terminalWidth={100} />
  );
}

describe('CodeHighlighter cache residency', () => {
  beforeEach(() => {
    clearCodeHighlightCache();
  });

  it('bounds unique highlighted lines by count and retained source size', () => {
    const content = Array.from(
      { length: HIGHLIGHT_CACHE_CAPACITY + 80 },
      (_, index) => `const value${index} = "render-${index}";`
    ).join('\n');
    expect(renderCode(content)).toContain('value');

    const stats = getCodeHighlightCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(HIGHLIGHT_CACHE_CAPACITY);
    expect(stats.size).toBeLessThanOrEqual(HIGHLIGHT_CACHE_MAX_RETAINED_CHARS);
  });

  it('does not retain a giant source line', () => {
    const oversized = `const value = "${'界'.repeat(
      HIGHLIGHT_CACHE_MAX_LINE_LENGTH + 1
    )}";`;
    expect(renderCode(oversized)).toContain('value');
    expect(getCodeHighlightCacheStats()).toEqual({
      entries: 0,
      size: 0,
      capacity: HIGHLIGHT_CACHE_CAPACITY,
      maxSize: HIGHLIGHT_CACHE_MAX_RETAINED_CHARS,
    });
  });
});
