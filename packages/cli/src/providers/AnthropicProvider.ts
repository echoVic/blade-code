/**
 * Anthropic Provider 实现
 */

import type {
	AIClient,
	AIProvider,
	ChatChunk,
	ChatOptions,
	ChatResponse,
	ModelInfo,
	ProviderConfig,
	ValidationResult,
} from './types';
import type { CoreMessage } from 'ai';

const ANTHROPIC_MODELS: ModelInfo[] = [
	{
		id: 'claude-opus-4-20250514',
		name: 'Claude Opus 4',
		contextWindow: 200000,
		maxOutputTokens: 16384,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 15, output: 75 },
	},
	{
		id: 'claude-3-5-sonnet-20241022',
		name: 'Claude 3.5 Sonnet',
		contextWindow: 200000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 3, output: 15 },
	},
	{
		id: 'claude-3-5-haiku-20241022',
		name: 'Claude 3.5 Haiku',
		contextWindow: 200000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 1, output: 5 },
	},
];

export class AnthropicProvider implements AIProvider {
	readonly name = 'anthropic';
	readonly models = ANTHROPIC_MODELS;
	readonly features = ['chat', 'streaming', 'vision', 'function-calling'] as const;

	createClient(config: ProviderConfig): AIClient {
		return new AnthropicClient(config);
	}

	validateConfig(config: ProviderConfig): ValidationResult {
		const errors: string[] = [];

		if (!config.apiKey) {
			errors.push('API Key 是必需的');
		}

		if (config.baseURL && !this.isValidUrl(config.baseURL)) {
			errors.push('baseURL 必须是有效的 URL');
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined,
		};
	}

	getDefaultModel(): string {
		return 'claude-3-5-sonnet-20241022';
	}

	getModelInfo(modelId: string): ModelInfo | undefined {
		return this.models.find((m) => m.id === modelId);
	}

	private isValidUrl(url: string): boolean {
		try {
			new URL(url);
			return true;
		} catch {
			return false;
		}
	}
}

class AnthropicClient implements AIClient {
	constructor(private config: ProviderConfig) {}

	async chat(messages: CoreMessage[], options?: ChatOptions): Promise<ChatResponse> {
		// 这里应该调用实际的 Anthropic API
		// 暂时返回模拟数据，待集成现有的 VercelAIChatService
		throw new Error('AnthropicClient.chat 需要集成现有实现');
	}

	async *stream(
		messages: CoreMessage[],
		options?: ChatOptions,
	): AsyncIterator<ChatChunk> {
		// 这里应该调用实际的 Anthropic 流式 API
		throw new Error('AnthropicClient.stream 需要集成现有实现');
	}

	async healthCheck(): Promise<boolean> {
		try {
			// 简单的健康检查
			return true;
		} catch {
			return false;
		}
	}
}
