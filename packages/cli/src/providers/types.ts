/**
 * AI Provider 抽象层类型定义
 */

import type { CoreMessage } from 'ai';

export interface ModelInfo {
	id: string;
	name: string;
	contextWindow: number;
	maxOutputTokens?: number;
	features: ModelFeature[];
	pricing?: {
		input: number; // 每百万 tokens 价格
		output: number;
		cached?: number;
	};
}

export type ModelFeature =
	| 'chat'
	| 'streaming'
	| 'vision'
	| 'function-calling'
	| 'json-mode'
	| 'embeddings';

export interface ProviderConfig {
	apiKey?: string;
	baseURL?: string;
	organization?: string;
	timeout?: number;
	maxRetries?: number;
	headers?: Record<string, string>;
	[key: string]: any;
}

export interface ChatOptions {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	topK?: number;
	stopSequences?: string[];
	stream?: boolean;
	tools?: any[];
	toolChoice?: string;
	responseFormat?: { type: 'json_object' | 'text' };
	metadata?: Record<string, any>;
}

export interface ChatResponse {
	content: string;
	finishReason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error';
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cachedTokens?: number;
	};
	toolCalls?: ToolCall[];
	metadata?: Record<string, any>;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, any>;
}

export interface ChatChunk {
	delta: string;
	finishReason?: ChatResponse['finishReason'];
	usage?: ChatResponse['usage'];
}

export interface ValidationResult {
	valid: boolean;
	errors?: string[];
}

export interface AIClient {
	/**
	 * 发送聊天消息
	 */
	chat(messages: CoreMessage[], options?: ChatOptions): Promise<ChatResponse>;

	/**
	 * 流式聊天
	 */
	stream(
		messages: CoreMessage[],
		options?: ChatOptions,
	): AsyncIterator<ChatChunk>;

	/**
	 * 获取嵌入向量（可选）
	 */
	embeddings?(texts: string[]): Promise<number[][]>;

	/**
	 * 健康检查
	 */
	healthCheck?(): Promise<boolean>;
}

export interface AIProvider {
	/**
	 * Provider 名称
	 */
	readonly name: string;

	/**
	 * 支持的模型列表
	 */
	readonly models: ModelInfo[];

	/**
	 * Provider 特性
	 */
	readonly features: ModelFeature[];

	/**
	 * 创建客户端实例
	 */
	createClient(config: ProviderConfig): AIClient;

	/**
	 * 验证配置
	 */
	validateConfig(config: ProviderConfig): ValidationResult;

	/**
	 * 获取默认模型
	 */
	getDefaultModel(): string;

	/**
	 * 获取模型信息
	 */
	getModelInfo(modelId: string): ModelInfo | undefined;
}

export type SupportedProvider =
	| 'anthropic'
	| 'openai'
	| 'google'
	| 'deepseek'
	| 'azure'
	| 'openrouter'
	| 'ollama'
	| 'groq'
	| 'custom';
