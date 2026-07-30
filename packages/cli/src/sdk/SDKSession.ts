/**
 * SDK Session 实现
 */

import type {
	SDKSession,
	SDKClientOptions,
	SDKSessionOptions,
	SDKMessage,
	SDKUserMessage,
	SDKAssistantMessage,
	SDKMessageChunk,
	SessionMetadata,
} from './types';
import type { ToolDefinition } from '../tools/types';
import { getGlobalRegistry } from '../providers';
import type { AIClient } from '../providers/types';

export class SDKSessionImpl implements SDKSession {
	public readonly id: string;
	private messages: SDKMessage[] = [];
	private tools = new Map<string, ToolDefinition>();
	private client: AIClient | null = null;
	private metadata: SessionMetadata;

	constructor(
		sessionId: string,
		private clientOptions: SDKClientOptions,
		private sessionOptions?: SDKSessionOptions,
	) {
		this.id = sessionId;
		this.metadata = {
			id: sessionId,
			model: sessionOptions?.model || 'claude-3-5-sonnet-20241022',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messageCount: 0,
			metadata: sessionOptions?.metadata,
		};

		// 注册初始工具
		if (sessionOptions?.tools) {
			for (const tool of sessionOptions.tools) {
				this.tools.set(tool.name, tool);
			}
		}
	}

	async initialize(): Promise<void> {
		// 初始化 AI 客户端
		const registry = getGlobalRegistry();
		const provider = registry.get(this.clientOptions.provider || 'anthropic');

		if (!provider) {
			throw new Error(`Provider ${this.clientOptions.provider} 未找到`);
		}

		this.client = provider.createClient({
			apiKey: this.clientOptions.apiKey,
			baseURL: this.clientOptions.baseURL,
			timeout: this.clientOptions.timeout,
			maxRetries: this.clientOptions.maxRetries,
		});
	}

	async send(message: string | SDKUserMessage): Promise<SDKAssistantMessage> {
		if (!this.client) {
			throw new Error('Session 未初始化');
		}

		// 构建用户消息
		const userMessage: SDKUserMessage = typeof message === 'string'
			? { role: 'user', content: message, timestamp: Date.now() }
			: message;

		this.messages.push(userMessage);

		// 准备消息历史
		const coreMessages = this.messages.map((msg) => ({
			role: msg.role,
			content: msg.content,
		}));

		// 调用 AI 客户端
		const response = await this.client.chat(coreMessages, {
			model: this.metadata.model,
			temperature: this.sessionOptions?.temperature,
			maxTokens: this.sessionOptions?.maxTokens,
		});

		// 构建助手消息
		const assistantMessage: SDKAssistantMessage = {
			role: 'assistant',
			content: response.content,
			timestamp: Date.now(),
			usage: response.usage,
		};

		this.messages.push(assistantMessage);
		this.metadata.messageCount = this.messages.length;
		this.metadata.updatedAt = Date.now();

		return assistantMessage;
	}

	async *stream(message: string | SDKUserMessage): AsyncIterator<SDKMessageChunk> {
		if (!this.client) {
			throw new Error('Session 未初始化');
		}

		// 构建用户消息
		const userMessage: SDKUserMessage = typeof message === 'string'
			? { role: 'user', content: message, timestamp: Date.now() }
			: message;

		this.messages.push(userMessage);

		// 准备消息历史
		const coreMessages = this.messages.map((msg) => ({
			role: msg.role,
			content: msg.content,
		}));

		// 流式调用
		let fullContent = '';
		for await (const chunk of this.client.stream(coreMessages, {
			model: this.metadata.model,
			temperature: this.sessionOptions?.temperature,
			maxTokens: this.sessionOptions?.maxTokens,
		})) {
			fullContent += chunk.delta;
			yield {
				delta: chunk.delta,
				done: false,
				usage: chunk.usage,
			};
		}

		// 保存完整的助手消息
		const assistantMessage: SDKAssistantMessage = {
			role: 'assistant',
			content: fullContent,
			timestamp: Date.now(),
		};
		this.messages.push(assistantMessage);
		this.metadata.messageCount = this.messages.length;
		this.metadata.updatedAt = Date.now();

		// 发送结束标记
		yield { delta: '', done: true };
	}

	getHistory(): SDKMessage[] {
		return [...this.messages];
	}

	clearHistory(): void {
		this.messages = [];
		this.metadata.messageCount = 0;
		this.metadata.updatedAt = Date.now();
	}

	addTool(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	removeTool(toolName: string): void {
		this.tools.delete(toolName);
	}

	getMetadata(): SessionMetadata {
		return { ...this.metadata };
	}

	async save(): Promise<void> {
		// TODO: 实现会话持久化
		throw new Error('save 需要实现持久化支持');
	}

	async close(): Promise<void> {
		this.client = null;
		this.messages = [];
		this.tools.clear();
	}
}
