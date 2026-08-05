import type { ModelConfig } from '../config/types.js';
import { getPiModelCatalog } from '../services/pi/PiModelCatalog.js';

export function detectThinkingSupport(modelName: string): boolean {
  return getPiModelCatalog()
    .models.getModels()
    .some((model) => model.id === modelName && model.reasoning);
}

export function getThinkingConfig(model: ModelConfig): {
  supportsThinking: boolean;
} {
  return {
    supportsThinking: getPiModelCatalog().resolveConfig(model).reasoning,
  };
}

export function isThinkingModel(model: ModelConfig): boolean {
  return getThinkingConfig(model).supportsThinking;
}
