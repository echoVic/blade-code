/**
 * 性能监控器测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PerformanceMonitor, getGlobalMonitor, resetGlobalMonitor } from '../../../src/monitoring';

describe('PerformanceMonitor', () => {
	let monitor: PerformanceMonitor;

	beforeEach(() => {
		monitor = new PerformanceMonitor();
	});

	describe('Token 追踪', () => {
		it('应该正确追踪 token 使用', () => {
			monitor.trackTokenUsage(100, 50, 10);
			const metrics = monitor.getMetrics();

			expect(metrics.tokens.input).toBe(100);
			expect(metrics.tokens.output).toBe(50);
			expect(metrics.tokens.cached).toBe(10);
			expect(metrics.tokens.total).toBe(150);
		});

		it('应该累积多次 token 使用', () => {
			monitor.trackTokenUsage(100, 50);
			monitor.trackTokenUsage(200, 100);

			const metrics = monitor.getMetrics();
			expect(metrics.tokens.input).toBe(300);
			expect(metrics.tokens.output).toBe(150);
			expect(metrics.tokens.total).toBe(450);
		});
	});

	describe('延迟追踪', () => {
		it('应该正确追踪 LLM 延迟', () => {
			monitor.trackLatency('llm', 1000);
			monitor.trackLatency('llm', 2000);

			const metrics = monitor.getMetrics();
			expect(metrics.latency.llm).toEqual([1000, 2000]);
		});

		it('应该限制延迟记录数量', () => {
			for (let i = 0; i < 150; i++) {
				monitor.trackLatency('llm', i);
			}

			const metrics = monitor.getMetrics();
			expect(metrics.latency.llm.length).toBeLessThanOrEqual(100);
		});

		it('应该追踪不同类型的操作延迟', () => {
			monitor.trackLatency('llm', 1000);
			monitor.trackLatency('toolExecution', 500);
			monitor.trackLatency('contextAssembly', 200);

			const metrics = monitor.getMetrics();
			expect(metrics.latency.llm).toEqual([1000]);
			expect(metrics.latency.toolExecution).toEqual([500]);
			expect(metrics.latency.contextAssembly).toEqual([200]);
		});
	});

	describe('缓存追踪', () => {
		it('应该正确追踪缓存命中', () => {
			monitor.trackCacheHit(true);
			const metrics = monitor.getMetrics();

			expect(metrics.cache.hits).toBe(1);
			expect(metrics.cache.misses).toBe(0);
			expect(metrics.cache.hitRate).toBe(1);
		});

		it('应该正确追踪缓存未命中', () => {
			monitor.trackCacheHit(false);
			const metrics = monitor.getMetrics();

			expect(metrics.cache.hits).toBe(0);
			expect(metrics.cache.misses).toBe(1);
			expect(metrics.cache.hitRate).toBe(0);
		});

		it('应该正确计算缓存命中率', () => {
			monitor.trackCacheHit(true);
			monitor.trackCacheHit(true);
			monitor.trackCacheHit(false);
			monitor.trackCacheHit(true);

			const metrics = monitor.getMetrics();
			expect(metrics.cache.hits).toBe(3);
			expect(metrics.cache.misses).toBe(1);
			expect(metrics.cache.hitRate).toBe(0.75);
		});
	});

	describe('错误追踪', () => {
		it('应该追踪错误和恢复', () => {
			monitor.trackError(true);
			monitor.trackError(false);

			const metrics = monitor.getMetrics();
			expect(metrics.errors.total).toBe(2);
			expect(metrics.errors.recovered).toBe(1);
			expect(metrics.errors.recoveryRate).toBe(0.5);
		});

		it('应该正确计算错误恢复率', () => {
			monitor.trackError(true);
			monitor.trackError(true);
			monitor.trackError(true);
			monitor.trackError(false);

			const metrics = monitor.getMetrics();
			expect(metrics.errors.recoveryRate).toBe(0.75);
		});
	});

	describe('会话追踪', () => {
		it('应该追踪会话开始', () => {
			monitor.trackSessionStart('session-1');
			const metrics = monitor.getMetrics();

			expect(metrics.sessions.active).toBe(1);
			expect(metrics.sessions.total).toBe(1);
		});

		it('应该追踪会话结束', () => {
			monitor.trackSessionStart('session-1');
			monitor.trackSessionEnd('session-1');

			const metrics = monitor.getMetrics();
			expect(metrics.sessions.active).toBe(0);
			expect(metrics.sessions.total).toBe(1);
		});

		it('应该追踪多个会话', () => {
			monitor.trackSessionStart('session-1');
			monitor.trackSessionStart('session-2');
			monitor.trackSessionEnd('session-1');

			const metrics = monitor.getMetrics();
			expect(metrics.sessions.active).toBe(1);
			expect(metrics.sessions.total).toBe(2);
		});
	});

	describe('计时器', () => {
		it('应该创建并停止计时器', async () => {
			const timer = monitor.startTimer('test-operation');
			await new Promise((resolve) => setTimeout(resolve, 100));
			const duration = timer.stop();

			expect(duration).toBeGreaterThanOrEqual(100);
		});

		it('应该记录计时器事件', () => {
			const timer = monitor.startTimer('test-operation');
			timer.stop();

			const events = monitor.getEvents();
			const timerEvent = events.find((e) => e.name === 'timer.test-operation');
			expect(timerEvent).toBeDefined();
		});
	});

	describe('报告生成', () => {
		it('应该生成性能报告', () => {
			monitor.trackTokenUsage(1000, 500);
			monitor.trackLatency('llm', 1500);
			monitor.trackCacheHit(true);
			monitor.trackCacheHit(false);

			const report = monitor.generateReport();

			expect(report.timestamp).toBeDefined();
			expect(report.metrics).toBeDefined();
			expect(report.summary).toContain('Token 使用');
			expect(report.summary).toContain('平均延迟');
			expect(report.summary).toContain('缓存命中率');
		});
	});

	describe('重置', () => {
		it('应该重置所有指标', () => {
			monitor.trackTokenUsage(1000, 500);
			monitor.trackLatency('llm', 1000);
			monitor.trackCacheHit(true);
			monitor.trackError(false);

			monitor.reset();

			const metrics = monitor.getMetrics();
			expect(metrics.tokens.total).toBe(0);
			expect(metrics.latency.llm).toEqual([]);
			expect(metrics.cache.hits).toBe(0);
			expect(metrics.errors.total).toBe(0);
		});
	});

	describe('全局实例', () => {
		it('应该返回全局监控器实例', () => {
			const monitor1 = getGlobalMonitor();
			const monitor2 = getGlobalMonitor();

			expect(monitor1).toBe(monitor2);
		});

		it('应该重置全局监控器', () => {
			const monitor1 = getGlobalMonitor();
			resetGlobalMonitor();
			const monitor2 = getGlobalMonitor();

			expect(monitor1).not.toBe(monitor2);
		});
	});
});
