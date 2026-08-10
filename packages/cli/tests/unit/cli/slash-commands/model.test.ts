import { describe, expect, it, vi } from 'vitest';

const {
  removeModel,
  updateModelProvider,
  removeModelProvider,
  configActions,
  getAllModels,
  getConfig,
  probeModelProvider,
} = vi.hoisted(() => {
  const removeModel = vi.fn().mockResolvedValue(undefined);
  const updateModelProvider = vi.fn().mockResolvedValue(undefined);
  const removeModelProvider = vi.fn().mockResolvedValue({
    removedModelIds: [],
  });
  const configActions = vi.fn(() => ({
    removeModel,
    updateModelProvider,
    removeModelProvider,
  }));
  const getAllModels = vi.fn();
  const getConfig = vi.fn();
  const probeModelProvider = vi.fn();
  return {
    removeModel,
    updateModelProvider,
    removeModelProvider,
    configActions,
    getAllModels,
    getConfig,
    probeModelProvider,
  };
});

vi.mock('../../../../src/store/vanilla.js', () => ({
  configActions,
  getAllModels,
  getConfig,
}));

vi.mock('../../../../src/services/ProviderHealthService.js', () => ({
  probeModelProvider,
}));

import modelCommand from '../../../../src/slash-commands/model.js';

describe('/model SlashCommand', () => {
  it('无参数且无模型时应提示添加模型', async () => {
    removeModel.mockClear();
    configActions.mockClear();
    getAllModels.mockReturnValueOnce([]);

    const result = await modelCommand.handler([], {} as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('没有可用的模型配置');
  });

  it('无参数且有模型时应返回 show_model_selector', async () => {
    removeModel.mockClear();
    configActions.mockClear();
    getAllModels.mockReturnValueOnce([
      { id: 'm1', displayName: 'Model 1', provider: 'openai', model: 'gpt-4' },
      { id: 'm2', displayName: 'Model 2', provider: 'openai', model: 'gpt-4.1' },
    ]);

    const result = await modelCommand.handler([], {} as any);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ action: 'show_model_selector' });
  });

  it('add 子命令应返回 show_model_add_wizard', async () => {
    removeModel.mockClear();
    configActions.mockClear();
    const result = await modelCommand.handler(['add'], {} as any);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ action: 'show_model_add_wizard', mode: 'add' });
  });

  it('remove 未提供名称时应返回错误', async () => {
    removeModel.mockClear();
    configActions.mockClear();
    const result = await modelCommand.handler(['remove'], {} as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('请指定要删除的模型名称');
  });

  it('remove 未匹配时应返回错误', async () => {
    removeModel.mockClear();
    configActions.mockClear();
    getAllModels.mockReturnValueOnce([
      {
        id: 'm1',
        displayName: 'Qwen',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      },
    ]);

    const result = await modelCommand.handler(['remove', 'Gemini'], {} as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('未找到匹配的模型配置');
  });

  it('remove 匹配时应调用 removeModel 并返回成功', async () => {
    getAllModels.mockReturnValueOnce([
      {
        id: 'm1',
        displayName: 'Qwen',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      },
      {
        id: 'm2',
        displayName: 'Gemini Pro',
        provider: 'google',
        model: 'gemini-2.5-pro',
      },
    ]);
    removeModel.mockClear();
    configActions.mockClear();

    const result = await modelCommand.handler(['remove', 'gemini'], {} as any);
    expect(result.success).toBe(true);
    expect(removeModel).toHaveBeenCalledWith('m2');
    expect(result.message).toContain('已删除模型配置');
  });

  it('provider list 不暴露凭据并显示渠道协议', async () => {
    getConfig.mockReturnValueOnce({
      modelProviders: {
        'team-gateway': {
          name: 'Team Gateway',
          baseUrl: 'https://gateway.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      models: [],
    });

    const result = await modelCommand.handler(['provider', 'list'], {} as any);
    expect(result.success).toBe(true);
    expect(result.message).toContain(
      'team-gateway · Team Gateway · openai-completions'
    );
    expect(result.message).not.toContain('apiKey');
  });

  it('provider test 使用 canonical probe 结果', async () => {
    const config = {
      temperature: 0,
      timeout: 30_000,
      modelProviders: {
        'team-gateway': {
          name: 'Team Gateway',
          baseUrl: 'https://gateway.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      models: [
        {
          id: 'team-model',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
      ],
    };
    getConfig.mockReturnValueOnce(config);
    probeModelProvider.mockResolvedValueOnce({
      ok: false,
      latencyMs: 12,
      wireApi: 'openai-completions',
      code: 'authentication',
      message: 'Provider authentication failed. Check model credentials.',
    });

    const result = await modelCommand.handler(
      ['provider', 'test', 'team-gateway'],
      {} as any
    );
    expect(result).toMatchObject({
      success: false,
      message:
        '[FAIL] team-gateway · Provider authentication failed. Check model credentials. [authentication]',
    });
    expect(probeModelProvider).toHaveBeenCalledWith(config.models[0], config, {
      timeoutMs: 10_000,
    });
  });

  it('provider set 和显式级联删除使用生命周期 actions', async () => {
    const provider = {
      name: 'Team Gateway',
      baseUrl: 'https://old.example.test/v1',
      wireApi: 'openai-completions',
    };
    getConfig.mockReturnValueOnce({
      modelProviders: { 'team-gateway': provider },
      models: [],
    });
    const updated = await modelCommand.handler(
      ['provider', 'set', 'team-gateway', 'https://new.example.test/v1'],
      {} as any
    );
    expect(updated.success).toBe(true);
    expect(updateModelProvider).toHaveBeenCalledWith('team-gateway', {
      ...provider,
      baseUrl: 'https://new.example.test/v1',
    });

    getConfig.mockReturnValueOnce({
      modelProviders: { 'team-gateway': provider },
      models: [],
    });
    removeModelProvider.mockResolvedValueOnce({
      removedModelIds: ['team-model'],
    });
    const removed = await modelCommand.handler(
      ['provider', 'remove', 'team-gateway', '--with-models'],
      {} as any
    );
    expect(removed.success).toBe(true);
    expect(removeModelProvider).toHaveBeenCalledWith('team-gateway', {
      removeModels: true,
    });
    expect(removed.message).toContain('同时删除 1 个模型配置');
  });
});
