import type { ModelConfig } from './types.js';

const LEGACY_GENERATED_MODEL_ID = /^[A-Za-z0-9_-]{21}$/;

function modelIdPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80) || 'model'
  );
}

export function createReadableModelId(
  model: Omit<ModelConfig, 'id'>,
  existingModels: readonly Pick<ModelConfig, 'id'>[]
): string {
  const existingIds = new Set(existingModels.map((entry) => entry.id));
  const modelId = modelIdPart(model.model);
  if (!existingIds.has(modelId)) return modelId;

  const providerModelId = `${modelIdPart(model.provider)}-${modelId}`.slice(0, 120);
  if (!existingIds.has(providerModelId)) return providerModelId;

  let suffix = 2;
  while (existingIds.has(`${providerModelId}-${suffix}`)) suffix++;
  return `${providerModelId}-${suffix}`;
}

export function migrateGeneratedModelIds(
  models: readonly ModelConfig[],
  currentModelId: string
): { models: ModelConfig[]; currentModelId: string; changed: boolean } {
  const reserved = models
    .filter((model) => !LEGACY_GENERATED_MODEL_ID.test(model.id))
    .map((model) => ({ id: model.id }));
  const migratedIds = new Map<string, string>();
  const migrated = models.map((model) => {
    if (!LEGACY_GENERATED_MODEL_ID.test(model.id)) return { ...model };
    const { id: legacyId, ...definition } = model;
    const id = createReadableModelId(definition, reserved);
    reserved.push({ id });
    migratedIds.set(legacyId, id);
    return { ...model, id };
  });

  return {
    models: migrated,
    currentModelId: migratedIds.get(currentModelId) ?? currentModelId,
    changed: migratedIds.size > 0,
  };
}
