/**
 * OpenAI Provider 实现
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

const OPENAI_MODELS: ModelInfo[] = [
	{
		id: 'gpt-4o',
		name: 'GPT-4o',
		contextWindow: 128000,
		maxOutputTokens: 16384,
		features: ['chat', 'streaming', 'vision', 'function-calling', 'json-mode'],
		pricing: { input: 2.5, output: 10 },
	},
	{
		id: 'gpt-4o-mini',
		name: 'GPT-4o Mini',
		contextWindow: 128000,
		maxOutputTokens: 16384,
		features: ['chat', 'streaming', 'vision', 'function-calling', 'json-mode'],
		pricing: { input: 0.15, output: 0.6 },
	},
	{
		id: 'o1',
		name: 'O1',
		contextWindow: 200000,
		maxOutputTokens: 100000,
		features: ['chat', 'streaming'],
		pricing: { input: 15, output: 60 },
	},
	{
		id: 'o1-mini',
		name: 'O1 Mini',
		contextWindow: 128000,
		maxOutputTokens: 65536,
		features: ['chat', 'streaming'],
		pricing: { input: 3, output: 12 },
	},
];

export class OpenAIProvider implements AIProvider {
	readonly name = 'openai';
	readonly models = OPENAI_MODELS;
	readonly features = ['chat', 'streaming', 'vision', 'function-calling', 'json-mode', 'embeddings'] as const;

	createClient(config: ProviderConfig): AIClient {
		return new OpenAIClient(config);
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
		return 'gpt-4o';
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

class OpenAIClient implements AIClient {
	constructor(private config: ProviderConfig) {}

	async chat(messages: CoreMessage[], options?: ChatOptions): Promise<ChatResponse> {
		throw new Error('OpenAIClient.chat 需要集成现有实现');
	}

	async *stream(
		messages: CoreMessage[],
		options?: ChatOptions,
	): AsyncIterator<ChatChunk> {
		throw new Error('OpenAIClient.stream 需要集成现有实现');
	}

	async embeddings(texts: string[]): Promise<number[][]> {
		throw new Error('OpenAIClient.embeddings 需要实现');
	}

	async healthCheck(): Promise<boolean> {
		try {
			return true;
		} catch {
			return false;
		}
	}
}
