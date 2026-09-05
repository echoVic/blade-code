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
const mockUseProviderRecovery = vi.fn(
  () =>
    null as
      | import('../../../../src/api/providerRecoverySchemas.js').ProviderRecoveryProjection
      | null
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
const mockUseTurnActivity = vi.fn(
  () =>
    null as
      | import('../../../../src/api/turnActivitySchemas.js').TurnActivityProjection
      | null
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
  useProviderRecovery: () => mockUseProviderRecovery(),
  useActionStationarity: () => mockUseActionStationarity(),
  useTurnActivity: () => mockUseTurnActivity(),
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
    mockUseProviderRecovery.mockReset();
    mockUseProviderRecovery.mockReturnValue(null);
    mockUseActionStationarity.mockReset();
    mockUseActionStationarity.mockReturnValue(null);
    mockUseTurnActivity.mockReset();
    mockUseTurnActivity.mockReturnValue(null);
  });

  it('显示 Runtime-owned 工具进度与回合计数', async () => {
    mockUseTurnActivity.mockReturnValue({
      version: 1,
      generation: 'activity-1',
      revision: 3,
      snapshot: {
        phase: 'executing_tools',
        startedAt: Date.now() - 65_000,
        updatedAt: Date.now(),
        turn: 2,
        maxTurns: 20,
        outputStarted: true,
        toolCallsStarted: 5,
        toolCallsCompleted: 3,
        activeTools: [
          {
            name: 'Read',
            kind: 'readonly',
            startedAt: Date.now(),
            progress: 1,
            total: 4,
          },
          { name: 'Bash', kind: 'execute', startedAt: Date.now() },
        ],
        activeToolOverflow: 2,
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('正在执行 4 个工具');
    expect(html).toContain('Read 1/4');
    expect(html).toContain('Bash');
    expect(html).toContain('+2');
    expect(html).toContain('工具 3/5');
    expect(html).toContain('回合 2/20');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('Provider 恢复优先于通用 turn activity', async () => {
    mockUseTurnActivity.mockReturnValue({
      version: 1,
      generation: 'activity-1',
      revision: 1,
      snapshot: {
        phase: 'executing_tools',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        turn: 1,
        maxTurns: 20,
        outputStarted: false,
        toolCallsStarted: 1,
        toolCallsCompleted: 0,
        activeTools: [{ name: 'Bash', startedAt: Date.now() }],
        activeToolOverflow: 0,
      },
    });
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'recovery-1',
      revision: 1,
      snapshot: {
        activity: 'retry_attempt',
        reason: 'transport',
        updatedAt: Date.now(),
        retry: { attempt: 1, maxRetries: 2 },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('正在重试 Provider');
    expect(html).not.toContain('正在执行 1 个工具');
  });

  it('显示 Runtime-owned Provider 恢复状态和 fallback 目标', async () => {
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'generation-1',
      revision: 1,
      snapshot: {
        activity: 'fallback',
        reason: 'server_error',
        updatedAt: Date.now(),
        fallback: {
          from: { provider: 'deepseek', model: 'deepseek-chat' },
          to: { provider: 'deepseek', model: 'deepseek-reasoner' },
          candidate: 1,
          candidateCount: 1,
          trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
        },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('正在切换到 deepseek-reasoner');
    expect(html).toContain('候选 1/1');
    expect(html).toContain('Esc 取消');
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
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'retry',
      revision: 1,
      snapshot: {
        activity: 'retry_wait',
        reason: 'server_error',
        updatedAt: Date.now(),
        nextActionAt: Date.now() + 1_250,
        retry: { attempt: 1, maxRetries: 2, delayMs: 1_250 },
      },
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

  it('在 Provider retry 前显示容量队列及等待时间', async () => {
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'admission',
      revision: 1,
      snapshot: {
        activity: 'admission_wait',
        reason: 'capacity',
        updatedAt: Date.now(),
        admission: {
          requestClass: 'foreground',
          resource: 'stream',
          scope: 'domain',
          queuePosition: 1,
          queueDepth: 2,
          inFlight: 4,
          limit: 4,
          waitMs: 15_000,
          maxWaitMs: 180_000,
        },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('等待 Provider 容量');
    expect(html).toContain('domain');
    expect(html).toContain('队列 1/2');
    expect(html).toContain('15s');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('Provider 暂时不可用');
  });

  it('显示有界前台恢复的剩余预算和取消入口', async () => {
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'bounded-retry',
      revision: 1,
      snapshot: {
        activity: 'retry_wait',
        reason: 'server_error',
        updatedAt: Date.now(),
        retry: {
          attempt: 4,
          maxRetries: 12,
          recoveryRemainingMs: 585_000,
        },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('Provider 暂时不可用');
    expect(html).toContain('4/12');
    expect(html).toContain('9m 45s');
    expect(html).toContain('Esc 取消');
    expect(html).not.toContain('炼化代码灵气...');
  });

  it('优先显示共享 Provider circuit 等待和唯一 probe', async () => {
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'circuit',
      revision: 1,
      snapshot: {
        activity: 'circuit_open',
        reason: 'server_error',
        updatedAt: Date.now(),
        nextActionAt: Date.now() + 2_000,
        circuit: {
          phase: 'waiting',
          retryAfterMs: 2_000,
          openDurationMs: 2_000,
          recoveryRemainingMs: 598_000,
        },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    let html = renderToStaticMarkup(React.createElement(LoadingIndicator));
    expect(html).toContain('Provider 故障已隔离，等待恢复探测');
    expect(html).toContain('2s');
    expect(html).toContain('9m 58s');
    expect(html).toContain('Esc 取消');

    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'circuit',
      revision: 2,
      snapshot: {
        activity: 'circuit_probe',
        reason: 'server_error',
        updatedAt: Date.now(),
        circuit: { phase: 'probe', openDurationMs: 2_000 },
      },
    });
    html = renderToStaticMarkup(React.createElement(LoadingIndicator));
    expect(html).toContain('Provider 正在执行恢复探测');
    expect(html).toContain('Esc 取消');
  });

  it('在 Provider stall 时显示空闲上限并保留取消入口', async () => {
    mockUseProviderRecovery.mockReturnValue({
      version: 1,
      generation: 'stall',
      revision: 1,
      snapshot: {
        activity: 'stream_stall',
        reason: 'stream_stall',
        updatedAt: Date.now(),
        stall: {
          stallCount: 1,
          durationMs: 30_000,
          warningAfterMs: 30_000,
          timeoutMs: 300_000,
          outputStarted: false,
        },
      },
    });
    const { LoadingIndicator } = await import(
      '../../../../src/ui/components/LoadingIndicator.js'
    );

    const html = renderToStaticMarkup(React.createElement(LoadingIndicator));

    expect(html).toContain('Provider 尚未返回流数据');
    expect(html).toContain('30s');
    expect(html).toContain('5m 0s');
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
