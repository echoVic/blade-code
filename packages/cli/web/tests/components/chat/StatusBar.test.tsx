// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  tokenUsage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    maxContextTokens: 100,
    isDefaultMaxTokens: false,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheBreak: undefined as
      | {
          reason: 'system_prompt_changed';
          previousCacheReadTokens: number;
          cacheReadTokens: number;
        }
      | undefined,
    estimatedCostUsd: 0,
  },
  isStreaming: true,
  agentPhase: 'compacting',
  providerAdmission: null as {
    queuePosition: number;
    queueDepth: number;
    scope: 'global' | 'domain' | 'owner' | 'class';
    waitMs: number;
  } | null,
  providerRetry: null as {
    phase?: 'scheduled' | 'waiting' | 'attempt' | 'exhausted';
    attempt: number;
    maxRetries: number;
    delayMs?: number;
    mode?: 'standard' | 'bounded_foreground';
    recoveryRemainingMs?: number;
  } | null,
  providerCircuit: null as {
    phase: 'opened' | 'waiting' | 'probe' | 'closed' | 'reopened' | 'rejected';
    retryAfterMs?: number;
    recoveryRemainingMs?: number;
  } | null,
  providerStall: null as {
    durationMs: number;
    timeoutMs: number;
  } | null,
  pendingResume: null as {
    phase: 'retry_scheduled';
    kind: 'pending_input';
    attempt: number;
    maxAttempts: number;
    delayMs?: number;
    failure?: { code: string; retryable: boolean };
  } | null,
  actionStationarity: null as {
    phase: 'detected' | 'halted';
    toolName: string;
    runLength: number;
    haltThreshold: number;
  } | null,
  turnRecovery: null as {
    state: 'requires_attention';
    turnId: string;
    inputMessageCount: number;
    reason: 'interrupted_tool_call' | 'successful_tool_result';
  } | null,
}));

vi.mock('@/store/session', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) =>
    selector(sessionState),
}));

import { StatusBar } from '../../../src/components/chat/StatusBar';

describe('StatusBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    sessionState.isStreaming = true;
    sessionState.agentPhase = 'compacting';
    sessionState.providerAdmission = null;
    sessionState.providerRetry = null;
    sessionState.providerCircuit = null;
    sessionState.providerStall = null;
    sessionState.pendingResume = null;
    sessionState.actionStationarity = null;
    sessionState.turnRecovery = null;
    Object.assign(sessionState.tokenUsage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      maxContextTokens: 100,
      isDefaultMaxTokens: false,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    });
    sessionState.tokenUsage.cacheBreak = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the active agent lifecycle phase', () => {
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Compacting context...');
    expect(container.textContent).not.toContain('Generating...');
  });

  it('keeps an interrupted tool recovery warning visible after streaming stops', () => {
    sessionState.isStreaming = false;
    sessionState.agentPhase = 'idle';
    sessionState.turnRecovery = {
      state: 'requires_attention',
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call',
    };

    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Recovery needs review');
    expect(container.textContent).toContain('Interrupted tool state is uncertain');
  });

  it('renders the cumulative prompt-cache hit rate', () => {
    Object.assign(sessionState.tokenUsage, {
      totalInputTokens: 1_000,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
    });

    act(() => {
      root.render(<StatusBar />);
    });

    const cache = container.querySelector('[data-testid="prompt-cache-hit-rate"]');
    expect(cache?.textContent).toContain('Cache60%');
    expect(cache?.getAttribute('aria-label')).toBe('Cache 60%');
  });

  it('renders an unavailable cache rate before Provider cache usage arrives', () => {
    act(() => {
      root.render(<StatusBar />);
    });

    const cache = container.querySelector('[data-testid="prompt-cache-hit-rate"]');
    expect(cache?.textContent).toContain('Cache—');
    expect(cache?.getAttribute('aria-label')).toBe('Cache —');
  });

  it('renders context-limit recovery as a distinct lifecycle phase', () => {
    sessionState.agentPhase = 'recovering_context';
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Recovering context limit...');
    expect(container.textContent).not.toContain('Compacting context...');
  });

  it('renders the Provider retry attempt and bounded wait', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerRetry = {
      attempt: 1,
      maxRetries: 2,
      delayMs: 1_250,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Provider');
    expect(container.textContent).toContain('Retrying');
    expect(container.textContent).toContain('1/2');
    expect(container.textContent).toContain('2s');
  });

  it('renders bounded foreground recovery and its remaining budget', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerRetry = {
      phase: 'waiting',
      attempt: 4,
      maxRetries: 12,
      mode: 'bounded_foreground',
      recoveryRemainingMs: 585_000,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Provider');
    expect(container.textContent).toContain('Bounded recovery');
    expect(container.textContent).toContain('4/12');
    expect(container.textContent).toContain('9m 45s');
  });

  it('renders Provider admission ahead of retry and ordinary phases', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerAdmission = {
      queuePosition: 1,
      queueDepth: 2,
      scope: 'domain',
      waitMs: 15_000,
    };
    sessionState.providerRetry = {
      phase: 'waiting',
      attempt: 4,
      maxRetries: 12,
      mode: 'bounded_foreground',
      recoveryRemainingMs: 585_000,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Provider');
    expect(container.textContent).toContain('Capacity queue 1/2');
    expect(container.textContent).toContain('domain');
    expect(container.textContent).toContain('15s');
    expect(container.textContent).not.toContain('Bounded recovery');
  });

  it('renders shared circuit waiting and probe ahead of request retry', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerRetry = {
      phase: 'waiting',
      attempt: 4,
      maxRetries: 12,
      mode: 'bounded_foreground',
      recoveryRemainingMs: 598_000,
    };
    sessionState.providerCircuit = {
      phase: 'waiting',
      retryAfterMs: 2_000,
      recoveryRemainingMs: 598_000,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Provider');
    expect(container.textContent).toContain('Circuit open');
    expect(container.textContent).toContain('probe in 2s');
    expect(container.textContent).toContain('9m 58s');
    expect(container.textContent).not.toContain('Bounded recovery');

    sessionState.providerCircuit = { phase: 'probe' };
    act(() => {
      root.render(<StatusBar />);
    });
    expect(container.textContent).toContain('Recovery probe');
  });

  it('renders Provider stall duration ahead of the normal phase', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerStall = {
      durationMs: 30_000,
      timeoutMs: 300_000,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Provider stream paused');
    expect(container.textContent).toContain('30s');
    expect(container.textContent).toContain('300s');
    expect(container.textContent).not.toContain('Generating...');
  });

  it('renders bounded pending resume without exposing canonical failure details', () => {
    sessionState.agentPhase = 'running';
    sessionState.pendingResume = {
      phase: 'retry_scheduled',
      kind: 'pending_input',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 1_250,
      failure: { code: 'provider_secret_timeout', retryable: true },
    };

    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Recovery attempt 2/4');
    expect(container.textContent).toContain('retry in 2s');
    expect(container.textContent).not.toContain('provider_secret_timeout');
  });

  it('keeps Provider retry ahead of pending resume and restores the ordinary phase after clear', () => {
    sessionState.agentPhase = 'running';
    sessionState.pendingResume = {
      phase: 'retry_scheduled',
      kind: 'pending_input',
      attempt: 2,
      maxAttempts: 4,
    };
    sessionState.providerRetry = { attempt: 1, maxRetries: 3 };

    act(() => {
      root.render(<StatusBar />);
    });
    expect(container.textContent).toContain('Provider');
    expect(container.textContent).not.toContain('Recovery attempt');

    sessionState.providerRetry = null;
    sessionState.pendingResume = null;
    act(() => {
      root.render(<StatusBar />);
    });
    expect(container.textContent).toContain('Generating...');
    expect(container.textContent).not.toContain('Recovery attempt');
  });

  it('renders action stationarity ahead of provider lifecycle state', () => {
    sessionState.agentPhase = 'running';
    sessionState.providerStall = {
      durationMs: 30_000,
      timeoutMs: 300_000,
    };
    sessionState.actionStationarity = {
      phase: 'detected',
      toolName: 'TaskOutput',
      runLength: 8,
      haltThreshold: 16,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Recovering');
    expect(container.textContent).toContain('TaskOutput');
    expect(container.textContent).toContain('8/16');
    expect(container.textContent).not.toContain('Provider stream paused');
  });
});
