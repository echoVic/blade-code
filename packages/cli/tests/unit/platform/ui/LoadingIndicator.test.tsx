import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseLoadingIndicator = vi.fn(
  (_isProcessing?: boolean, _isWaiting?: boolean, _paused?: boolean) => ({
    currentPhrase: '炼化代码灵气...',
    elapsedTime: 0,
  })
);
const mockUseTerminalWidth = vi.fn(() => 120);
const mockUseProviderRetry = vi.fn(
  () =>
    null as {
      phase: 'scheduled' | 'waiting' | 'attempt' | 'exhausted';
      attempt: number;
      maxRetries: number;
      delayMs?: number;
      mode?: 'standard' | 'bounded_foreground';
      recoveryRemainingMs?: number;
    } | null
);
const mockUseProviderStall = vi.fn(
  () =>
    null as {
      phase: 'detected';
      stallCount: number;
      durationMs: number;
      warningAfterMs: number;
      timeoutMs: number;
      outputStarted: boolean;
    } | null
);
const mockUseActionStationarity = vi.fn(
  () =>
    null as {
      phase: 'detected' | 'recovered' | 'halted';
      toolName: string;
      runLength: number;
      nudgeThreshold: number;
      haltThreshold: number;
      progressAware: boolean;
    } | null
);

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => true,
  useIsReady: () => true,
  useProviderRetry: () => mockUseProviderRetry(),
  useProviderStall: () => mockUseProviderStall(),
  useActionStationarity: () => mockUseActionStationarity(),
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
  useLoadingIndicator: (
    isProcessing?: boolean,
    isWaiting?: boolean,
    paused?: boolean
  ) => mockUseLoadingIndicator(isProcessing, isWaiting, paused),
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
    mockUseProviderRetry.mockReset();
    mockUseProviderRetry.mockReturnValue(null);
    mockUseProviderStall.mockReset();
    mockUseProviderStall.mockReturnValue(null);
    mockUseActionStationarity.mockReset();
    mockUseActionStationarity.mockReturnValue(null);
  });

  it('短时间加载时应该优先显示中性文案而不是趣味短语', async () => {
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(
      React.createElement(LoadingIndicator, { message: '处理中...' })
    );

    expect(html).toContain('处理中...');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('优先显示可取消的 Provider 重试状态', async () => {
    mockUseProviderRetry.mockReturnValue({
      phase: 'scheduled',
      attempt: 1,
      maxRetries: 2,
      delayMs: 1_250,
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('Provider 暂时不可用');
    expect(html).toContain('1/2');
    expect(html).toContain('2s');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('显示有界前台恢复的剩余预算和取消入口', async () => {
    mockUseProviderRetry.mockReturnValue({
      phase: 'waiting',
      attempt: 4,
      maxRetries: 12,
      mode: 'bounded_foreground',
      recoveryRemainingMs: 585_000,
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('Provider 暂时不可用，正在有界恢复');
    expect(html).toContain('4/12');
    expect(html).toContain('9m 45s');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('在 Provider stall 时显示空闲上限并保留取消入口', async () => {
    mockUseProviderStall.mockReturnValue({
      phase: 'detected',
      stallCount: 1,
      durationMs: 30_000,
      warningAfterMs: 30_000,
      timeoutMs: 300_000,
      outputStarted: false,
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('Provider 尚未返回流数据');
    expect(html).toContain('30s');
    expect(html).toContain('300s');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('检测到工具空转时优先显示纠偏状态', async () => {
    mockUseActionStationarity.mockReturnValue({
      phase: 'detected',
      toolName: 'TaskOutput',
      runLength: 8,
      nudgeThreshold: 8,
      haltThreshold: 16,
      progressAware: true,
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('检测到 TaskOutput 连续 8 次无进展');
    expect(html).toContain('正在要求 Agent 切换策略');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('stationarity 达到停止阈值时显示终止状态', async () => {
    mockUseActionStationarity.mockReturnValue({
      phase: 'halted',
      toolName: 'Read',
      runLength: 16,
      nudgeThreshold: 8,
      haltThreshold: 16,
      progressAware: false,
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('已停止 Read 空转循环');
    expect(html).toContain('Esc 取消');
  });
});
