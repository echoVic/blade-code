/**
 * Blade Code SDK 类型定义
 */

import type { CoreMessage } from 'ai';
import type { ToolDefinition } from '../tools/types';
import type { ChatOptions, ChatResponse } from '../providers/types';

export interface SDKClientOptions {
	/** API Key */
	apiKey?: string;
	/** Provider 名称 */
	provider?: string;
	/** 基础 URL */
	baseURL?: string;
	/** 超时时间（毫秒） */
	timeout?: number;
	/** 最大重试次数 */
	maxRetries?: number;
	/** 调试模式 */
	debug?: boolean;
}

export interface SDKClient {
	/** 创建会话 */
	createSession(options?: SDKSessionOptions): Promise<SDKSession>;
	/** 恢复会话 */
	resumeSession(sessionId: string): Promise<SDKSession>;
	/** 列出所有会话 */
	listSessions(): Promise<SessionMetadata[]>;
	/** 获取客户端配置 */
	getConfig(): SDKClientOptions;
}

export interface SDKSessionOptions {
	/** 模型 ID */
	model?: string;
	/** 系统提示词 */
	systemPrompt?: string;
	/** 温度 */
	temperature?: number;
	/** 最大 Token 数 */
	maxTokens?: number;
	/** 工具列表 */
	tools?: ToolDefinition[];
	/** 会话元数据 */
	metadata?: Record<string, any>;
}

export interface SDKSession {
	/** 会话 ID */
	id: string;
	/** 发送消息 */
	send(message: string | SDKUserMessage): Promise<SDKAssistantMessage>;
	/** 流式发送消息 */
	stream(message: string | SDKUserMessage): AsyncIterator<SDKMessageChunk>;
	/** 获取消息历史 */
	getHistory(): SDKMessage[];
	/** 清空历史 */
	clearHistory(): void;
	/** 添加工具 */
	addTool(tool: ToolDefinition): void;
	/** 移除工具 */
	removeTool(toolName: string): void;
	/** 获取会话元数据 */
	getMetadata(): SessionMetadata;
	/** 保存会话 */
	save(): Promise<void>;
	/** 关闭会话 */
	close(): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	model: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	metadata?: Record<string, any>;
}

export type SDKMessage = SDKUserMessage | SDKAssistantMessage;

export interface SDKUserMessage {
	role: 'user';
	content: string;
	timestamp: number;
}

export interface SDKAssistantMessage {
	role: 'assistant';
	content: string;
	timestamp: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
	toolCalls?: Array<{
		name: string;
		arguments: Record<string, any>;
		result?: any;
	}>;
}

export interface SDKMessageChunk {
	delta: string;
	done: boolean;
	usage?: SDKAssistantMessage['usage'];
}

export type SDKEventType =
	| 'message'
	| 'tool-call'
	| 'error'
	| 'session-start'
	| 'session-end';

export interface SDKEvent {
	type: SDKEventType;
	data: any;
	timestamp: number;
}

export type SDKEventHandler = (event: SDKEvent) => void;
