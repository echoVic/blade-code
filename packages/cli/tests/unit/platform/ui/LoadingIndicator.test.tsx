import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseLoadingIndicator = vi.fn(() => ({
  currentPhrase: '炼化代码灵气...',
  elapsedTime: 0,
}));
const mockUseTerminalWidth = vi.fn(() => 120);

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => true,
  useIsReady: () => true,
  useTheme: () => ({
    colors: {
      warning: 'yellow',
      text: { primary: 'white' },
      muted: 'gray',
      info: 'blue',
      secondary: 'cyan',
    },
  }),
}));

vi.mock('../../../../src/ui/hooks/useLoadingIndicator.js', () => ({
  useLoadingIndicator: (...args: unknown[]) => mockUseLoadingIndicator(...args),
}));

vi.mock('../../../../src/ui/hooks/useTerminalWidth.js', () => ({
  useTerminalWidth: () => mockUseTerminalWidth(),
}));

describe('LoadingIndicator', () => {
  beforeEach(() => {
    mockUseLoadingIndicator.mockReset();
    mockUseLoadingIndicator.mockReturnValue({
      currentPhrase: '炼化代码灵气...',
      elapsedTime: 0,
    });
    mockUseTerminalWidth.mockReset();
    mockUseTerminalWidth.mockReturnValue(120);
  });

  it('短时间加载时应该优先显示中性文案而不是趣味短语', async () => {
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.tsx'
    );

    const html = renderToStaticMarkup(
      React.createElement(LoadingIndicator, { message: '处理中...' })
    );

    expect(html).toContain('处理中...');
    expect(html).not.toContain('炼化代码灵气...');
  });
});
