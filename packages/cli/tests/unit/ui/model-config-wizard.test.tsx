import { describe, expect, it } from 'vitest';
import { getPreviousWizardStep } from '../../../src/ui/components/model-config/wizardFlow.js';

describe('pi-ai model config wizard flow', () => {
  it('uses provider -> model -> credential flow', () => {
    expect(getPreviousWizardStep('model')).toBe('provider');
    expect(getPreviousWizardStep('credential')).toBe('model');
    expect(getPreviousWizardStep('provider')).toBeUndefined();
  });
});
