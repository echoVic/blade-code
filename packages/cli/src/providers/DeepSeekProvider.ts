/**
 * DeepSeek Provider 实现
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

const DEEPSEEK_MODELS: ModelInfo[] = [
	{
		id: 'deepseek-chat',
		name: 'DeepSeek Chat',
		contextWindow: 64000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'function-calling'],
		pricing: { input: 0.14, output: 0.28 },
	},
	{
		id: 'deepseek-reasoner',
		name: 'DeepSeek Reasoner',
		contextWindow: 64000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming'],
		pricing: { input: 0.55, output: 2.19 },
	},
];

export class DeepSeekProvider implements AIProvider {
	readonly name = 'deepseek';
	readonly models = DEEPSEEK_MODELS;
	readonly features = ['chat', 'streaming', 'function-calling'] as const;

	createClient(config: ProviderConfig): AIClient {
		return new DeepSeekClient(config);
	}

	validateConfig(config: ProviderConfig): ValidationResult {
		const errors: string[] = [];

		if (!config.apiKey) {
			errors.push('API Key 是必需的');
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined,
		};
	}

	getDefaultModel(): string {
		return 'deepseek-chat';
	}

	getModelInfo(modelId: string): ModelInfo | undefined {
		return this.models.find((m) => m.id === modelId);
	}
}

class DeepSeekClient implements AIClient {
	constructor(private config: ProviderConfig) {}

	async chat(messages: CoreMessage[], options?: ChatOptions): Promise<ChatResponse> {
		throw new Error('DeepSeekClient.chat 需要集成现有实现');
	}

	async *stream(
		messages: CoreMessage[],
		options?: ChatOptions,
	): AsyncIterator<ChatChunk> {
		throw new Error('DeepSeekClient.stream 需要集成现有实现');
	}

	async healthCheck(): Promise<boolean> {
		try {
			return true;
		} catch {
			return false;
		}
	}
}
