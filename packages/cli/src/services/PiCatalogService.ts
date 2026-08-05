import type { ModelCatalogEntry, ProviderCatalogEntry } from './pi/catalogTypes.js';
import { getPiModelCatalog } from './pi/PiModelCatalog.js';

export type ProviderOption = ProviderCatalogEntry;
export type ModelOption = ModelCatalogEntry;

export async function getProviders(): Promise<ProviderOption[]> {
  return getPiModelCatalog().listProviders();
}

export async function getModelsForProvider(providerId: string): Promise<ModelOption[]> {
  return getPiModelCatalog().listModels(providerId);
}
