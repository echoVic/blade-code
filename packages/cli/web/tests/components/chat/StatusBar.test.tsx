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
    estimatedCostUsd: 0,
  },
  isStreaming: true,
  agentPhase: 'compacting',
  providerRetry: null as {
    attempt: number;
    maxRetries: number;
    delayMs?: number;
  } | null,
  providerStall: null as {
    durationMs: number;
    timeoutMs: number;
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
    sessionState.providerRetry = null;
    sessionState.providerStall = null;
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
});
