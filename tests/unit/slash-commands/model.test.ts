import { describe, expect, it, vi } from 'vitest';

const { removeModel, configActions, getAllModels } = vi.hoisted(() => {
  const removeModel = vi.fn().mockResolvedValue(undefined);
  const configActions = vi.fn(() => ({ removeModel }));
  const getAllModels = vi.fn();
  return { removeModel, configActions, getAllModels };
});

vi.mock('../../../src/store/vanilla.js', () => ({
  configActions,
  getAllModels,
}));

import modelCommand from '../../../src/slash-commands/model.js';

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
      { id: 'm1', name: 'Model 1' },
      { id: 'm2', name: 'Model 2' },
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
    getAllModels.mockReturnValueOnce([{ id: 'm1', name: 'Qwen' }]);

    const result = await modelCommand.handler(['remove', 'Gemini'], {} as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('未找到匹配的模型配置');
  });

  it('remove 匹配时应调用 removeModel 并返回成功', async () => {
    getAllModels.mockReturnValueOnce([
      { id: 'm1', name: 'Qwen' },
      { id: 'm2', name: 'Gemini Pro' },
    ]);
    removeModel.mockClear();
    configActions.mockClear();

    const result = await modelCommand.handler(['remove', 'gemini'], {} as any);
    expect(result.success).toBe(true);
    expect(removeModel).toHaveBeenCalledWith('m2');
    expect(result.message).toContain('已删除模型配置');
  });
});
