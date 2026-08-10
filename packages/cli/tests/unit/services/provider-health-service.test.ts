import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeModelProvider } from '../../../src/services/ProviderHealthService.js';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  resolveModelConfig: vi.fn(),
}));

vi.mock('../../../src/services/PiAIChatService.js', () => ({
  PiAIChatService: class {
    chat = mocks.chat;
  },
}));

vi.mock('../../../src/services/pi/resolveModelConfig.js', () => ({
  resolveModelConfig: mocks.resolveModelConfig,
}));

describe('ProviderHealthService', () => {
  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.resolveModelConfig.mockReset();
    mocks.resolveModelConfig.mockReturnValue({
      model: { api: 'openai-completions' },
      chat: {
        provider: 'team-gateway',
        model: 'vendor-model',
      },
    });
  });

  it('projects a successful probe without returning model content', async () => {
    mocks.chat.mockResolvedValue({
      content: 'sensitive provider response',
      finishReason: 'stop',
    });

    const result = await probeModelProvider(
      {
        id: 'model-config',
        provider: 'team-gateway',
        model: 'vendor-model',
      },
      { temperature: 0, timeout: 30_000 }
    );

    expect(result).toMatchObject({
      ok: true,
      providerId: 'team-gateway',
      modelConfigId: 'model-config',
      model: 'vendor-model',
      wireApi: 'openai-completions',
      code: 'ok',
      message: 'Provider responded successfully.',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive provider response');
  });

  it('returns only canonical failure details', async () => {
    mocks.chat.mockRejectedValue(
      new Error(
        '401 invalid api key sk-sensitive-value at /private/provider/config.json'
      )
    );

    const result = await probeModelProvider(
      {
        id: 'model-config',
        provider: 'team-gateway',
        model: 'vendor-model',
      },
      { temperature: 0, timeout: 30_000 }
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'authentication',
      message: 'Provider authentication failed. Check model credentials.',
    });
    expect(JSON.stringify(result)).not.toContain('sk-sensitive-value');
    expect(JSON.stringify(result)).not.toContain('/private/provider');
  });

  it('classifies runtime resolution failures without throwing', async () => {
    mocks.resolveModelConfig.mockImplementation(() => {
      throw new Error('ECONNREFUSED https://secret-endpoint.example');
    });

    await expect(
      probeModelProvider(
        {
          id: 'model-config',
          provider: 'team-gateway',
          model: 'vendor-model',
        },
        { temperature: 0, timeout: 30_000 }
      )
    ).resolves.toMatchObject({
      ok: false,
      wireApi: 'unknown',
      code: 'network',
      message: 'Provider connection failed.',
    });
  });
});
