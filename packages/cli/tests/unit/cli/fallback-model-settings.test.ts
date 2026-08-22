import { describe, expect, it } from 'vitest';
import { loadCliSettings } from '../../../src/cli/settings.js';

describe('fallback model settings', () => {
  it('accepts an explicit fallback model config ID', async () => {
    const settings = await loadCliSettings(
      JSON.stringify({
        models: [
          {
            id: 'primary',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            fallbackModels: [
              {
                provider: 'openai',
                model: 'gpt-5.5',
                configId: 'fallback-gpt',
              },
            ],
          },
          {
            id: 'fallback-gpt',
            provider: 'openai',
            model: 'gpt-5.5',
          },
        ],
      })
    );

    expect(settings?.models?.[0]).toMatchObject({
      fallbackModels: [
        {
          provider: 'openai',
          model: 'gpt-5.5',
          configId: 'fallback-gpt',
        },
      ],
    });
  });

  it('rejects an empty fallback model config ID', async () => {
    await expect(
      loadCliSettings(
        JSON.stringify({
          models: [
            {
              id: 'primary',
              provider: 'anthropic',
              model: 'claude-opus-4-8',
              fallbackModels: [
                {
                  provider: 'openai',
                  model: 'gpt-5.5',
                  configId: '',
                },
              ],
            },
          ],
        })
      )
    ).rejects.toThrow('Invalid --settings value');
  });
});
