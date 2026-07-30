/**
 * AI Provider 系统导出
 */

export { ProviderRegistry, getGlobalRegistry, resetGlobalRegistry } from './ProviderRegistry';
export { AnthropicProvider } from './AnthropicProvider';
export { OpenAIProvider } from './OpenAIProvider';
export { GoogleProvider } from './GoogleProvider';
export { DeepSeekProvider } from './DeepSeekProvider';

export type {
	AIProvider,
	AIClient,
	ModelInfo,
	ModelFeature,
	ProviderConfig,
	ChatOptions,
	ChatResponse,
	ChatChunk,
	ToolCall,
	ValidationResult,
	SupportedProvider,
} from './types';

/**
 * 初始化并注册所有内置 Providers
 */
export function initializeProviders(): void {
	const registry = getGlobalRegistry();

	registry.register(new AnthropicProvider());
	registry.register(new OpenAIProvider());
	registry.register(new GoogleProvider());
	registry.register(new DeepSeekProvider());
}
