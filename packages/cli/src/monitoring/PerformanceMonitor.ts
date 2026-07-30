/**
 * 性能监控器
 * 用于追踪 Token 使用、延迟、缓存命中率等关键指标
 */

import type {
	MetricEvent,
	PerformanceMetrics,
	PerformanceReport,
	Timer,
} from './types';

export class PerformanceMonitor {
	private metrics: PerformanceMetrics = {
		tokens: { input: 0, output: 0, total: 0, cached: 0 },
		latency: { llm: [], toolExecution: [], contextAssembly: [] },
		cache: { hits: 0, misses: 0, hitRate: 0 },
		errors: { total: 0, recovered: 0, recoveryRate: 0 },
		sessions: { active: 0, total: 0, averageDuration: 0 },
	};

	private events: MetricEvent[] = [];
	private sessionStartTimes = new Map<string, number>();

	/**
	 * 追踪 Token 使用
	 */
	trackTokenUsage(input: number, output: number, cached = 0): void {
		this.metrics.tokens.input += input;
		this.metrics.tokens.output += output;
		this.metrics.tokens.cached += cached;
		this.metrics.tokens.total = this.metrics.tokens.input + this.metrics.tokens.output;

		this.recordEvent('tokens.used', input + output, { type: 'total' });
	}

	/**
	 * 追踪延迟
	 */
	trackLatency(operation: 'llm' | 'toolExecution' | 'contextAssembly', ms: number): void {
		this.metrics.latency[operation].push(ms);
		this.recordEvent(`latency.${operation}`, ms);

		// 保持最近 100 条记录，避免内存无限增长
		if (this.metrics.latency[operation].length > 100) {
			this.metrics.latency[operation].shift();
		}
	}

	/**
	 * 追踪缓存命中
	 */
	trackCacheHit(hit: boolean): void {
		if (hit) {
			this.metrics.cache.hits++;
		} else {
			this.metrics.cache.misses++;
		}

		const total = this.metrics.cache.hits + this.metrics.cache.misses;
		this.metrics.cache.hitRate = total > 0 ? this.metrics.cache.hits / total : 0;

		this.recordEvent('cache.access', hit ? 1 : 0, { result: hit ? 'hit' : 'miss' });
	}

	/**
	 * 追踪错误
	 */
	trackError(recovered: boolean): void {
		this.metrics.errors.total++;
		if (recovered) {
			this.metrics.errors.recovered++;
		}

		const total = this.metrics.errors.total;
		this.metrics.errors.recoveryRate =
			total > 0 ? this.metrics.errors.recovered / total : 0;

		this.recordEvent('error.occurred', 1, { recovered: String(recovered) });
	}

	/**
	 * 追踪会话开始
	 */
	trackSessionStart(sessionId: string): void {
		this.sessionStartTimes.set(sessionId, Date.now());
		this.metrics.sessions.active++;
		this.metrics.sessions.total++;

		this.recordEvent('session.started', 1, { sessionId });
	}

	/**
	 * 追踪会话结束
	 */
	trackSessionEnd(sessionId: string): void {
		const startTime = this.sessionStartTimes.get(sessionId);
		if (startTime) {
			const duration = Date.now() - startTime;
			this.sessionStartTimes.delete(sessionId);
			this.metrics.sessions.active--;

			// 更新平均时长
			const total = this.metrics.sessions.total;
			const current = this.metrics.sessions.averageDuration;
			this.metrics.sessions.averageDuration = (current * (total - 1) + duration) / total;

			this.recordEvent('session.ended', duration, { sessionId });
		}
	}

	/**
	 * 创建计时器
	 */
	startTimer(name: string): Timer {
		const startTime = Date.now();
		return {
			name,
			startTime,
			stop: () => {
				const duration = Date.now() - startTime;
				this.recordEvent(`timer.${name}`, duration);
				return duration;
			},
		};
	}

	/**
	 * 记录事件
	 */
	private recordEvent(name: string, value: number, tags?: Record<string, string>): void {
		this.events.push({
			name,
			value,
			timestamp: Date.now(),
			tags,
		});

		// 保持最近 1000 条事件
		if (this.events.length > 1000) {
			this.events.shift();
		}
	}

	/**
	 * 获取当前指标
	 */
	getMetrics(): PerformanceMetrics {
		return { ...this.metrics };
	}

	/**
	 * 获取事件列表
	 */
	getEvents(): MetricEvent[] {
		return [...this.events];
	}

	/**
	 * 生成性能报告
	 */
	generateReport(): PerformanceReport {
		const metrics = this.getMetrics();

		// 计算延迟统计
		const avgLlmLatency = this.calculateAverage(metrics.latency.llm);
		const avgToolLatency = this.calculateAverage(metrics.latency.toolExecution);
		const avgContextLatency = this.calculateAverage(metrics.latency.contextAssembly);

		const summary = [
			`Token 使用: ${metrics.tokens.total.toLocaleString()} (输入: ${metrics.tokens.input.toLocaleString()}, 输出: ${metrics.tokens.output.toLocaleString()}, 缓存: ${metrics.tokens.cached.toLocaleString()})`,
			`平均延迟: LLM ${avgLlmLatency.toFixed(0)}ms, 工具 ${avgToolLatency.toFixed(0)}ms, 上下文 ${avgContextLatency.toFixed(0)}ms`,
			`缓存命中率: ${(metrics.cache.hitRate * 100).toFixed(1)}% (${metrics.cache.hits}/${metrics.cache.hits + metrics.cache.misses})`,
			`错误恢复率: ${(metrics.errors.recoveryRate * 100).toFixed(1)}% (${metrics.errors.recovered}/${metrics.errors.total})`,
			`活跃会话: ${metrics.sessions.active}, 总会话: ${metrics.sessions.total}, 平均时长: ${(metrics.sessions.averageDuration / 1000).toFixed(1)}s`,
		].join('\n');

		return {
			timestamp: Date.now(),
			metrics,
			summary,
		};
	}

	/**
	 * 计算平均值
	 */
	private calculateAverage(values: number[]): number {
		if (values.length === 0) return 0;
		const sum = values.reduce((a, b) => a + b, 0);
		return sum / values.length;
	}

	/**
	 * 重置指标
	 */
	reset(): void {
		this.metrics = {
			tokens: { input: 0, output: 0, total: 0, cached: 0 },
			latency: { llm: [], toolExecution: [], contextAssembly: [] },
			cache: { hits: 0, misses: 0, hitRate: 0 },
			errors: { total: 0, recovered: 0, recoveryRate: 0 },
			sessions: { active: 0, total: 0, averageDuration: 0 },
		};
		this.events = [];
		this.sessionStartTimes.clear();
	}
}

// 单例实例
let globalMonitor: PerformanceMonitor | null = null;

/**
 * 获取全局性能监控器实例
 */
export function getGlobalMonitor(): PerformanceMonitor {
	if (!globalMonitor) {
		globalMonitor = new PerformanceMonitor();
	}
	return globalMonitor;
}

/**
 * 重置全局性能监控器
 */
export function resetGlobalMonitor(): void {
	globalMonitor = null;
}
