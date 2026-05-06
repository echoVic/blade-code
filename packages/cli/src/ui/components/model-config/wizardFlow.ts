import type { WizardStep } from './types.js';

export const getStepAfterApiKeySubmit = (): WizardStep => 'baseUrl';

export const getPreviousWizardStep = (
  step: WizardStep
): WizardStep | undefined => {
  switch (step) {
    case 'apiKey':
      return 'provider';
    case 'baseUrl':
      return 'apiKey';
    case 'model':
      return 'baseUrl';
    default:
      return undefined;
  }
};
