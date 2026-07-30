/**
 * Google (Gemini) Provider 实现
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

const GOOGLE_MODELS: ModelInfo[] = [
	{
		id: 'gemini-2.0-flash-exp',
		name: 'Gemini 2.0 Flash',
		contextWindow: 1000000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 0, output: 0 }, // Free tier available
	},
	{
		id: 'gemini-1.5-pro',
		name: 'Gemini 1.5 Pro',
		contextWindow: 2000000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 1.25, output: 5 },
	},
	{
		id: 'gemini-1.5-flash',
		name: 'Gemini 1.5 Flash',
		contextWindow: 1000000,
		maxOutputTokens: 8192,
		features: ['chat', 'streaming', 'vision', 'function-calling'],
		pricing: { input: 0.075, output: 0.3 },
	},
];

export class GoogleProvider implements AIProvider {
	readonly name = 'google';
	readonly models = GOOGLE_MODELS;
	readonly features = ['chat', 'streaming', 'vision', 'function-calling'] as const;

	createClient(config: ProviderConfig): AIClient {
		return new GoogleClient(config);
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
		return 'gemini-2.0-flash-exp';
	}

	getModelInfo(modelId: string): ModelInfo | undefined {
		return this.models.find((m) => m.id === modelId);
	}
}

class GoogleClient implements AIClient {
	constructor(private config: ProviderConfig) {}

	async chat(messages: CoreMessage[], options?: ChatOptions): Promise<ChatResponse> {
		throw new Error('GoogleClient.chat 需要集成现有实现');
	}

	async *stream(
		messages: CoreMessage[],
		options?: ChatOptions,
	): AsyncIterator<ChatChunk> {
		throw new Error('GoogleClient.stream 需要集成现有实现');
	}

	async healthCheck(): Promise<boolean> {
		try {
			return true;
		} catch {
			return false;
		}
	}
}
