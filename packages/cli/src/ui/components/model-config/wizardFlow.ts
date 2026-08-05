import type { WizardStep } from './types.js';

export function getPreviousWizardStep(step: WizardStep): WizardStep | undefined {
  if (step === 'model') return 'provider';
  if (step === 'credential') return 'model';
  return undefined;
}
