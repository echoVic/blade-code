import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('@/logging/Logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { SERVICE: 'service' },
}));

const mockModelsDevData = {
  anthropic: {
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    doc: 'https://docs.anthropic.com',
    models: {
      'claude-sonnet-4-20250514': {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        limit: { context: 200000, output: 8192 },
        cost: { input: 3, output: 15 },
      },
      'claude-3-5-haiku-20241022': {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        limit: { context: 200000, output: 8192 },
        cost: { input: 1, output: 5 },
      },
    },
  },
  openai: {
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/docs',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10 },
      },
    },
  },
  'empty-provider': {
    name: 'Empty Provider',
    models: {},
  },
};

describe('ModelsDevService', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchModelsDevData', () => {
    it('应成功获取 models.dev 数据', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { fetchModelsDevData } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const data = await fetchModelsDevData();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://models.dev/api.json',
        expect.objectContaining({
          headers: { 'User-Agent': 'Blade-CLI/1.0' },
        })
      );
      expect(data).toEqual(mockModelsDevData);
    });

    it('应使用缓存数据', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { fetchModelsDevData } = await import(
        '../../../src/services/ModelsDevService.js'
      );

      await fetchModelsDevData();
      await fetchModelsDevData();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('HTTP 错误时应抛出异常', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { fetchModelsDevData } = await import(
        '../../../src/services/ModelsDevService.js'
      );

      await expect(fetchModelsDevData()).rejects.toThrow('HTTP 500');
    });

    it('网络错误时应抛出异常', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { fetchModelsDevData } = await import(
        '../../../src/services/ModelsDevService.js'
      );

      await expect(fetchModelsDevData()).rejects.toThrow('Network error');
    });
  });

  describe('getProviders', () => {
    it('应返回格式化的 Provider 列表', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getProviders } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const providers = await getProviders();

      expect(providers.length).toBe(2);

      const anthropic = providers.find((p) => p.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic?.name).toBe('Anthropic');
      expect(anthropic?.description).toBe('2 个模型');
      expect(anthropic?.envVars).toContain('ANTHROPIC_API_KEY');
    });

    it('应过滤掉没有模型的 Provider', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getProviders } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const providers = await getProviders();

      const emptyProvider = providers.find((p) => p.id === 'empty-provider');
      expect(emptyProvider).toBeUndefined();
    });

    it('应按热门程度排序 Provider', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getProviders } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const providers = await getProviders();

      const anthropicIndex = providers.findIndex((p) => p.id === 'anthropic');
      const openaiIndex = providers.findIndex((p) => p.id === 'openai');

      expect(anthropicIndex).toBeLessThan(openaiIndex);
    });
  });

  describe('getModelsForProvider', () => {
    it('应返回指定 Provider 的模型列表', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getModelsForProvider } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const models = await getModelsForProvider('anthropic');

      expect(models.length).toBe(2);

      const sonnet = models.find((m) => m.id === 'claude-sonnet-4-20250514');
      expect(sonnet).toBeDefined();
      expect(sonnet?.name).toBe('Claude Sonnet 4');
      expect(sonnet?.contextWindow).toBe(200000);
      expect(sonnet?.inputCost).toBe(3);
      expect(sonnet?.outputCost).toBe(15);
    });

    it('Provider 不存在时应返回空数组', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getModelsForProvider } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const models = await getModelsForProvider('non-existent');

      expect(models).toEqual([]);
    });

    it('Provider 没有模型时应返回空数组', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModelsDevData),
      });

      const { getModelsForProvider } = await import(
        '../../../src/services/ModelsDevService.js'
      );
      const models = await getModelsForProvider('empty-provider');

      expect(models).toEqual([]);
    });
  });
});
