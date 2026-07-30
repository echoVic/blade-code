/**
 * 错误恢复管理器
 *
 * 提供智能的错误恢复策略，包括：
 * - 自动重试
 * - 降级策略
 * - 用户提示
 * - 错误报告
 */

import type { BladeError } from './index';
import {
	AgentExecutionError,
	NetworkError,
	RateLimitError,
	ToolExecutionError,
} from './index';

/**
 * 恢复结果
 */
export interface RecoveryResult {
	success: boolean;
	message?: string;
	data?: any;
	retryable?: boolean;
	suggestedAction?: string;
}

/**
 * 重试配置
 */
export interface RetryConfig {
	maxAttempts: number;
	initialDelay: number;
	maxDelay: number;
	backoffMultiplier: number;
	retryableErrors: string[];
}

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	initialDelay: 1000,
	maxDelay: 10000,
	backoffMultiplier: 2,
	retryableErrors: [
		'NETWORK_ERROR',
		'TIMEOUT_ERROR',
		'RATE_LIMIT_ERROR',
		'MCP_CONNECTION_ERROR',
	],
};

/**
 * 错误恢复管理器
 */
export class ErrorRecoveryManager {
	private retryConfig: RetryConfig;
	private retryAttempts = new Map<string, number>();

	constructor(config?: Partial<RetryConfig>) {
		this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
	}

	/**
	 * 尝试恢复错误
	 */
	async recover(error: BladeError, context?: any): Promise<RecoveryResult> {
		// 不可恢复的错误直接返回
		if (!error.recoverable) {
			return {
				success: false,
				message: error.message,
				retryable: false,
				suggestedAction: this.getSuggestedAction(error),
			};
		}

		// 根据错误类型选择恢复策略
		if (error instanceof NetworkError) {
			return this.recoverNetworkError(error, context);
		}

		if (error instanceof RateLimitError) {
			return this.recoverRateLimitError(error, context);
		}

		if (error instanceof ToolExecutionError) {
			return this.recoverToolExecutionError(error, context);
		}

		if (error instanceof AgentExecutionError) {
			return this.recoverAgentExecutionError(error, context);
		}

		// 默认恢复策略：尝试重试
		return this.retryWithBackoff(error, context);
	}

	/**
	 * 网络错误恢复
	 */
	private async recoverNetworkError(
		error: NetworkError,
		context?: any,
	): Promise<RecoveryResult> {
		// 检查是否可以重试
		if (error.statusCode && error.statusCode >= 500) {
			// 服务器错误，可以重试
			return this.retryWithBackoff(error, context);
		}

		if (error.statusCode === 429) {
			// 转换为 RateLimitError 处理
			const rateLimitError = new RateLimitError(
				error.message,
				undefined,
				true,
			);
			return this.recoverRateLimitError(rateLimitError, context);
		}

		// 客户端错误，不可恢复
		return {
			success: false,
			message: `网络请求失败: ${error.message}`,
			retryable: false,
			suggestedAction: '请检查网络连接和 API 配置',
		};
	}

	/**
	 * 限流错误恢复
	 */
	private async recoverRateLimitError(
		error: RateLimitError,
		context?: any,
	): Promise<RecoveryResult> {
		const retryAfter = error.retryAfter || 5000;

		return {
			success: false,
			message: `API 限流，需要等待 ${Math.ceil(retryAfter / 1000)} 秒`,
			retryable: true,
			suggestedAction: `等待 ${Math.ceil(retryAfter / 1000)} 秒后重试`,
			data: { retryAfter },
		};
	}

	/**
	 * 工具执行错误恢复
	 */
	private async recoverToolExecutionError(
		error: ToolExecutionError,
		context?: any,
	): Promise<RecoveryResult> {
		// 工具执行失败，尝试使用替代工具或降级
		return {
			success: false,
			message: `工具 ${error.toolName} 执行失败: ${error.message}`,
			retryable: true,
			suggestedAction: '尝试使用其他工具或手动执行操作',
		};
	}

	/**
	 * Agent 执行错误恢复
	 */
	private async recoverAgentExecutionError(
		error: AgentExecutionError,
		context?: any,
	): Promise<RecoveryResult> {
		// Agent 执行失败，可能需要重新初始化或降级
		return {
			success: false,
			message: `Agent 执行失败: ${error.message}`,
			retryable: true,
			suggestedAction: '尝试重启会话或简化输入',
		};
	}

	/**
	 * 指数退避重试
	 */
	private async retryWithBackoff(
		error: BladeError,
		context?: any,
	): Promise<RecoveryResult> {
		// 检查错误是否可重试
		if (!this.retryConfig.retryableErrors.includes(error.code)) {
			return {
				success: false,
				message: error.message,
				retryable: false,
				suggestedAction: this.getSuggestedAction(error),
			};
		}

		// 获取当前重试次数
		const key = this.getRetryKey(error);
		const attempts = this.retryAttempts.get(key) || 0;

		// 检查是否超过最大重试次数
		if (attempts >= this.retryConfig.maxAttempts) {
			this.retryAttempts.delete(key);
			return {
				success: false,
				message: `重试 ${attempts} 次后仍然失败: ${error.message}`,
				retryable: false,
				suggestedAction: this.getSuggestedAction(error),
			};
		}

		// 计算延迟时间（指数退避）
		const delay = Math.min(
			this.retryConfig.initialDelay *
				this.retryConfig.backoffMultiplier ** attempts,
			this.retryConfig.maxDelay,
		);

		// 更新重试次数
		this.retryAttempts.set(key, attempts + 1);

		return {
			success: false,
			message: `第 ${attempts + 1} 次重试，等待 ${Math.ceil(delay / 1000)} 秒`,
			retryable: true,
			data: { delay, attempts: attempts + 1 },
		};
	}

	/**
	 * 获取重试键
	 */
	private getRetryKey(error: BladeError): string {
		return `${error.code}:${error.message}`;
	}

	/**
	 * 获取建议操作
	 */
	private getSuggestedAction(error: BladeError): string {
		switch (error.code) {
			case 'CONFIGURATION_ERROR':
				return '请检查配置文件是否正确';
			case 'NETWORK_ERROR':
				return '请检查网络连接';
			case 'VALIDATION_ERROR':
				return '请检查输入参数';
			case 'FILE_SYSTEM_ERROR':
				return '请检查文件路径和权限';
			case 'PERMISSION_ERROR':
				return '请检查操作权限';
			case 'TOKEN_LIMIT_ERROR':
				return '请减少输入长度或使用压缩';
			default:
				return '请查看错误详情或联系支持';
		}
	}

	/**
	 * 重置重试计数
	 */
	resetRetries(errorKey?: string): void {
		if (errorKey) {
			this.retryAttempts.delete(errorKey);
		} else {
			this.retryAttempts.clear();
		}
	}

	/**
	 * 获取重试统计
	 */
	getRetryStats(): Map<string, number> {
		return new Map(this.retryAttempts);
	}
}

/**
 * 全局错误恢复管理器实例
 */
export const globalRecoveryManager = new ErrorRecoveryManager();
