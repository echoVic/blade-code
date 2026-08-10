import type { Api, Model } from '@earendil-works/pi-ai';
import type { ServiceTierSelection } from '../../config/types.js';

export type { ServiceTierSelection };

export const SERVICE_TIER_SELECTIONS = [
  'auto',
  'standard',
  'fast',
  'flex',
] as const satisfies readonly ServiceTierSelection[];

export type ServiceTierEffective = 'provider-default' | 'standard' | 'fast' | 'flex';

export type ProviderServiceTier = 'default' | 'priority' | 'flex' | 'fast';

export interface ServiceTierConfiguration {
  selection: ServiceTierSelection;
  effective: ServiceTierEffective;
  supported: Exclude<ServiceTierSelection, 'auto'>[];
  providerValue?: ProviderServiceTier;
}

const OPENAI_SERVICE_TIER_APIS = new Set<Api>([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

export function isServiceTierSelection(value: unknown): value is ServiceTierSelection {
  return (
    typeof value === 'string' &&
    SERVICE_TIER_SELECTIONS.includes(value as ServiceTierSelection)
  );
}

export function getSupportedServiceTiers(
  model: Model<Api>
): Exclude<ServiceTierSelection, 'auto'>[] {
  if (OPENAI_SERVICE_TIER_APIS.has(model.api)) {
    return ['standard', 'fast', 'flex'];
  }
  if (
    model.api === 'anthropic-messages' &&
    /(?:^|-)claude-opus-4-6(?:-|$)/i.test(model.id)
  ) {
    return ['standard', 'fast'];
  }
  return ['standard'];
}

export function resolveServiceTier(
  model: Model<Api>,
  selection: ServiceTierSelection
): ServiceTierConfiguration {
  const supported = getSupportedServiceTiers(model);
  if (selection !== 'auto' && !supported.includes(selection)) {
    throw new Error(`Service tier ${selection} is not supported by ${model.name}`);
  }
  if (selection === 'auto') {
    return { selection, effective: 'provider-default', supported };
  }
  if (selection === 'standard') {
    return {
      selection,
      effective: 'standard',
      supported,
      ...(OPENAI_SERVICE_TIER_APIS.has(model.api)
        ? { providerValue: 'default' as const }
        : {}),
    };
  }
  if (selection === 'fast') {
    return {
      selection,
      effective: 'fast',
      supported,
      providerValue: model.api === 'anthropic-messages' ? 'fast' : 'priority',
    };
  }
  return {
    selection,
    effective: 'flex',
    supported,
    providerValue: 'flex',
  };
}
