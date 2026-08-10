import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore } from '../../src/store/ConfigStore';

describe('ConfigStore', () => {
  beforeEach(() => {
    useConfigStore.setState({
      currentModelId: null,
      configuredModels: [],
      availableModels: [],
      isLoading: false,
      hasLoaded: false,
      loadedWorkspacePath: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deduplicates concurrent model discovery and records readiness', async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);

    const first = useConfigStore.getState().loadModels();
    const second = useConfigStore.getState().loadModels();
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveResponse(
      new Response(
        JSON.stringify({
          current: {
            id: 'model-1',
            provider: 'openai',
            model: 'gpt-4',
          },
          configured: [
            {
              id: 'model-1',
              provider: 'openai',
              model: 'gpt-4',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    await Promise.all([first, second]);

    expect(useConfigStore.getState()).toMatchObject({
      currentModelId: 'model-1',
      isLoading: false,
      hasLoaded: true,
      error: null,
    });
  });

  it('preserves known models and exposes discovery failures', async () => {
    useConfigStore.setState({
      currentModelId: 'model-1',
      configuredModels: [
        {
          id: 'model-1',
          provider: 'openai',
          model: 'gpt-4',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Model registry unavailable' },
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await useConfigStore.getState().loadModels();

    expect(useConfigStore.getState()).toMatchObject({
      currentModelId: 'model-1',
      configuredModels: [
        {
          id: 'model-1',
          provider: 'openai',
          model: 'gpt-4',
        },
      ],
      isLoading: false,
      hasLoaded: true,
      error: 'Model registry unavailable',
    });
  });

  it('rejects failed model selection without changing the active model', async () => {
    useConfigStore.setState({
      currentModelId: 'model-1',
      hasLoaded: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Config update rejected' },
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(useConfigStore.getState().setCurrentModel('model-2')).rejects.toThrow(
      'Config update rejected'
    );
    expect(useConfigStore.getState()).toMatchObject({
      currentModelId: 'model-1',
      error: 'Config update rejected',
    });
  });

  it('keeps the latest workspace model response when requests finish out of order', async () => {
    const resolvers = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const workspace = new Headers(init?.headers).get('x-blade-directory') ?? '';
      return new Promise<Response>((resolve) => {
        resolvers.set(workspace, resolve);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const loadA = useConfigStore.getState().loadModels('/workspace/a');
    const loadB = useConfigStore.getState().loadModels('/workspace/b');
    const responseFor = (workspace: 'a' | 'b') =>
      new Response(
        JSON.stringify({
          current: {
            id: `model-${workspace}`,
            provider: 'shared-channel',
            model: 'gpt-4.1',
          },
          configured: [
            {
              id: `model-${workspace}`,
              provider: 'shared-channel',
              model: 'gpt-4.1',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    resolvers.get('/workspace/b')?.(responseFor('b'));
    await loadB;
    resolvers.get('/workspace/a')?.(responseFor('a'));
    await loadA;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useConfigStore.getState()).toMatchObject({
      loadedWorkspacePath: '/workspace/b',
      currentModelId: 'model-b',
      configuredModels: [expect.objectContaining({ id: 'model-b' })],
      hasLoaded: true,
      isLoading: false,
    });
  });
});
