/**
 * Blade Code SDK 主入口
 * 提供编程式访问 Blade Code 的能力
 */

// Client
export { createClient } from './SDKClient';
export type { SDKClient, SDKClientOptions } from './types';

// Session
export type {
	SDKSession,
	SDKSessionOptions,
	SessionMetadata,
} from './types';

// Messages
export type {
	SDKMessage,
	SDKUserMessage,
	SDKAssistantMessage,
	SDKMessageChunk,
} from './types';

// Events
export type {
	SDKEvent,
	SDKEventType,
	SDKEventHandler,
} from './types';

// Utilities
export { formatMarkdown } from './utils';

/**
 * 快速创建会话并发送消息的便捷函数
 */
export async function prompt(
	clientOptions: import('./types').SDKClientOptions,
	message: string,
	sessionOptions?: import('./types').SDKSessionOptions,
): Promise<string> {
	const { createClient } = await import('./SDKClient');
	const client = createClient(clientOptions);
	const session = await client.createSession(sessionOptions);
	const response = await session.send(message);
	await session.close();
	return response.content;
}
