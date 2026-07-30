/**
 * SDK Client 实现
 */

import type {
	SDKClient,
	SDKClientOptions,
	SDKSession,
	SDKSessionOptions,
	SessionMetadata,
} from './types';
import { SDKSessionImpl } from './SDKSession';
import { getGlobalRegistry } from '../providers';

export class SDKClientImpl implements SDKClient {
	constructor(private options: SDKClientOptions) {
		// 验证配置
		if (!options.provider) {
			options.provider = 'anthropic';
		}
	}

	async createSession(options?: SDKSessionOptions): Promise<SDKSession> {
		const sessionId = this.generateSessionId();
		const session = new SDKSessionImpl(sessionId, this.options, options);
		await session.initialize();
		return session;
	}

	async resumeSession(sessionId: string): Promise<SDKSession> {
		// TODO: 从存储中加载会话
		throw new Error('resumeSession 需要实现持久化支持');
	}

	async listSessions(): Promise<SessionMetadata[]> {
		// TODO: 从存储中列出会话
		throw new Error('listSessions 需要实现持久化支持');
	}

	getConfig(): SDKClientOptions {
		return { ...this.options };
	}

	private generateSessionId(): string {
		return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}
}

/**
 * 创建 SDK 客户端
 */
export function createClient(options: SDKClientOptions): SDKClient {
	return new SDKClientImpl(options);
}
