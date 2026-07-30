/**
 * 错误恢复管理器测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AgentExecutionError,
	NetworkError,
	RateLimitError,
	ToolExecutionError,
} from '../../../src/errors/index.js';
import { ErrorRecoveryManager } from '../../../src/errors/recovery.js';

describe('错误恢复管理器', () => {
	let manager: ErrorRecoveryManager;

	beforeEach(() => {
		manager = new ErrorRecoveryManager({
			maxAttempts: 3,
			initialDelay: 100,
			maxDelay: 1000,
			backoffMultiplier: 2,
		});
	});

	describe('网络错误恢复', () => {
		it('应该重试 5xx 服务器错误', async () => {
			const error = new NetworkError('服务器错误', 500);
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.retryable).toBe(true);
			expect(result.message).toContain('重试');
		});

		it('应该将 429 转换为限流错误处理', async () => {
			const error = new NetworkError('Too Many Requests', 429);
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.message).toContain('限流');
		});

		it('不应该重试 4xx 客户端错误', async () => {
			const error = new NetworkError('Bad Request', 400);
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.retryable).toBe(false);
			expect(result.suggestedAction).toBeTruthy();
		});
	});

	describe('限流错误恢复', () => {
		it('应该返回等待时间', async () => {
			const error = new RateLimitError('限流', 5000);
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.retryable).toBe(true);
			expect(result.message).toContain('等待');
			expect(result.data?.retryAfter).toBe(5000);
		});

		it('应该使用默认等待时间', async () => {
			const error = new RateLimitError('限流');
			const result = await manager.recover(error);

			expect(result.data?.retryAfter).toBe(5000);
		});
	});

	describe('工具执行错误恢复', () => {
		it('应该提供工具名称和建议', async () => {
			const error = new ToolExecutionError('执行失败', 'ReadFile');
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.message).toContain('ReadFile');
			expect(result.suggestedAction).toBeTruthy();
		});
	});

	describe('Agent 执行错误恢复', () => {
		it('应该提供恢复建议', async () => {
			const error = new AgentExecutionError('执行失败', 'planning');
			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.suggestedAction).toBeTruthy();
		});
	});

	describe('重试机制', () => {
		it('应该实现指数退避', async () => {
			const error = new NetworkError('连接失败', 500);

			// 第一次重试
			const result1 = await manager.recover(error);
			expect(result1.data?.delay).toBe(100);
			expect(result1.data?.attempts).toBe(1);

			// 第二次重试
			const result2 = await manager.recover(error);
			expect(result2.data?.delay).toBe(200);
			expect(result2.data?.attempts).toBe(2);

			// 第三次重试
			const result3 = await manager.recover(error);
			expect(result3.data?.delay).toBe(400);
			expect(result3.data?.attempts).toBe(3);
		});

		it('应该在达到最大重试次数后停止', async () => {
			const error = new NetworkError('连接失败', 500);

			// 重试 3 次
			await manager.recover(error);
			await manager.recover(error);
			await manager.recover(error);

			// 第 4 次应该失败
			const result = await manager.recover(error);
			expect(result.success).toBe(false);
			expect(result.retryable).toBe(false);
			expect(result.message).toContain('重试 3 次后仍然失败');
		});

		it('应该限制最大延迟', async () => {
			const manager = new ErrorRecoveryManager({
				maxAttempts: 10,
				initialDelay: 100,
				maxDelay: 500,
				backoffMultiplier: 2,
			});

			const error = new NetworkError('连接失败', 500);

			// 多次重试直到达到最大延迟
			for (let i = 0; i < 5; i++) {
				await manager.recover(error);
			}

			const result = await manager.recover(error);
			expect(result.data?.delay).toBeLessThanOrEqual(500);
		});
	});

	describe('重试统计', () => {
		it('应该跟踪重试次数', async () => {
			const error1 = new NetworkError('错误1', 500);
			const error2 = new NetworkError('错误2', 500);

			await manager.recover(error1);
			await manager.recover(error1);
			await manager.recover(error2);

			const stats = manager.getRetryStats();
			expect(stats.size).toBeGreaterThan(0);
		});

		it('应该能重置重试计数', async () => {
			const error = new NetworkError('连接失败', 500);

			await manager.recover(error);
			await manager.recover(error);

			manager.resetRetries();

			const stats = manager.getRetryStats();
			expect(stats.size).toBe(0);
		});
	});

	describe('不可恢复错误', () => {
		it('应该直接返回不可恢复错误', async () => {
			const error = new NetworkError('致命错误', 400, undefined, false);
			error.recoverable = false;

			const result = await manager.recover(error);

			expect(result.success).toBe(false);
			expect(result.retryable).toBe(false);
			expect(result.suggestedAction).toBeTruthy();
		});
	});

	describe('建议操作', () => {
		it('应该为配置错误提供建议', async () => {
			const { ConfigurationError } = await import('../../../src/errors/index.js');
			const error = new ConfigurationError('配置无效');

			const result = await manager.recover(error);
			expect(result.suggestedAction).toContain('配置');
		});

		it('应该为权限错误提供建议', async () => {
			const { PermissionError } = await import('../../../src/errors/index.js');
			const error = new PermissionError('无权访问');

			const result = await manager.recover(error);
			expect(result.suggestedAction).toContain('权限');
		});

		it('应该为 token 限制错误提供建议', async () => {
			const { TokenLimitError } = await import('../../../src/errors/index.js');
			const error = new TokenLimitError('超出限制', 10000, 8000);

			const result = await manager.recover(error);
			expect(result.suggestedAction).toBeTruthy();
		});
	});
});
