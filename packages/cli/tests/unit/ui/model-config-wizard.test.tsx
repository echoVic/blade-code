import { describe, expect, it } from 'vitest';
import { buildCustomProviderSetup } from '../../../src/ui/components/model-config/CustomProviderInput.js';
import { getPreviousWizardStep } from '../../../src/ui/components/model-config/wizardFlow.js';

describe('pi-ai model config wizard flow', () => {
  it('uses provider -> model -> credential flow', () => {
    expect(getPreviousWizardStep('custom')).toBe('provider');
    expect(getPreviousWizardStep('model')).toBe('provider');
    expect(getPreviousWizardStep('credential')).toBe('model');
    expect(getPreviousWizardStep('provider')).toBeUndefined();
  });

  it('builds a credential-free custom channel config', () => {
    expect(
      buildCustomProviderSetup(
        {
          id: 'team-gateway',
          name: '',
          baseUrl: 'https://gateway.example.test/v1',
          model: 'vendor-model',
        },
        'openai-completions'
      )
    ).toEqual({
      provider: 'team-gateway',
      model: 'vendor-model',
      displayName: 'vendor-model',
      modelProvider: {
        name: 'team-gateway',
        baseUrl: 'https://gateway.example.test/v1',
        wireApi: 'openai-completions',
      },
    });
  });

  it('rejects unsafe channel ids and non-http endpoints', () => {
    expect(() =>
      buildCustomProviderSetup(
        {
          id: 'Bad Channel',
          name: 'Bad',
          baseUrl: 'https://gateway.example.test/v1',
          model: 'vendor-model',
        },
        'openai-completions'
      )
    ).toThrow('id must match');
    expect(() =>
      buildCustomProviderSetup(
        {
          id: 'team-gateway',
          name: 'Bad',
          baseUrl: 'file:///tmp/socket',
          model: 'vendor-model',
        },
        'openai-completions'
      )
    ).toThrow('HTTP(S)');
  });
});
