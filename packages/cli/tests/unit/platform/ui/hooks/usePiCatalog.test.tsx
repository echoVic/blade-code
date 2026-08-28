// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../../../../../src/ui/components/model-config/types.js';

const mocks = vi.hoisted(() => ({
  getModelsForProvider: vi.fn(),
  getProviders: vi.fn(),
}));

vi.mock('../../../../../src/services/PiCatalogService.js', () => ({
  getModelsForProvider: mocks.getModelsForProvider,
  getProviders: mocks.getProviders,
}));

import { useModels } from '../../../../../src/ui/components/model-config/hooks/usePiCatalog.js';

function model(id: string, provider: string): ModelOption {
  return {
    id,
    name: id,
    provider,
    api: 'openai-completions',
    baseUrl: 'https://example.test',
    reasoning: false,
    supportedReasoningEfforts: [],
    supportedServiceTiers: [],
    supportedResponseVerbosities: [],
    input: ['text'],
    contextWindow: 16_000,
    maxTokens: 4_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useModels', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let provider: string | undefined;
  let state: ReturnType<typeof useModels> | undefined;

  function Harness() {
    state = useModels(provider);
    return null;
  }

  beforeEach(() => {
    mocks.getModelsForProvider.mockReset();
    provider = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('returns to an idle empty state when the provider is cleared', async () => {
    const request = deferred<ModelOption[]>();
    mocks.getModelsForProvider.mockReturnValue(request.promise);
    provider = 'provider-a';
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(state?.isLoading).toBe(true);

    provider = undefined;
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(state).toEqual({ models: [], isLoading: false, error: null });
    request.resolve([model('model-a', 'provider-a')]);
    await act(async () => {
      await request.promise;
    });
    expect(state).toEqual({ models: [], isLoading: false, error: null });
  });

  it('ignores a stale response after switching providers', async () => {
    const requestA = deferred<ModelOption[]>();
    const requestB = deferred<ModelOption[]>();
    mocks.getModelsForProvider.mockImplementation((providerId: string) =>
      providerId === 'provider-a' ? requestA.promise : requestB.promise
    );

    provider = 'provider-a';
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    provider = 'provider-b';
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    requestB.resolve([model('model-b', 'provider-b')]);
    await act(async () => {
      await requestB.promise;
    });
    expect(state?.models.map((entry) => entry.id)).toEqual(['model-b']);

    requestA.resolve([model('model-a', 'provider-a')]);
    await act(async () => {
      await requestA.promise;
    });
    expect(state?.models.map((entry) => entry.id)).toEqual(['model-b']);
  });
});
