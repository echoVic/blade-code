import { getPiModelCatalog } from './pi/PiModelCatalog.js';

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  providerId?: string
): number {
  const catalog = getPiModelCatalog();
  const model = providerId
    ? catalog.models.getModel(providerId, modelId)
    : catalog.models.getModels().find((entry) => entry.id === modelId);
  if (!model) return 0;

  const rates = model.cost;
  const cost =
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (cacheReadTokens / 1_000_000) * rates.cacheRead +
    (cacheWriteTokens / 1_000_000) * rates.cacheWrite;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
