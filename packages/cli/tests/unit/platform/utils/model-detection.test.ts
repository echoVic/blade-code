import { describe, expect, it } from 'vitest';
import {
  detectThinkingSupport,
  getThinkingConfig,
  isThinkingModel,
} from '../../../../src/utils/modelDetection.js';

describe('modelDetection', () => {
  it('uses pi-ai reasoning metadata instead of name patterns', () => {
    expect(detectThinkingSupport('deepseek-v4-pro')).toBe(true);
    expect(detectThinkingSupport('gpt-4')).toBe(false);
    expect(detectThinkingSupport('unknown-model')).toBe(false);
  });

  it('resolves reasoning capability through provider and model IDs', () => {
    const reasoning = {
      id: 'reasoning',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    };
    const standard = {
      id: 'standard',
      provider: 'openai',
      model: 'gpt-4',
    };

    expect(getThinkingConfig(reasoning).supportsThinking).toBe(true);
    expect(isThinkingModel(reasoning)).toBe(true);
    expect(isThinkingModel(standard)).toBe(false);
  });
});
