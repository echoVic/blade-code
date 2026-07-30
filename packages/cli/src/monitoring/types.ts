/**
 * 性能监控系统类型定义
 */

export interface PerformanceMetrics {
	/** Token 使用统计 */
	tokens: {
		input: number;
		output: number;
		total: number;
		cached: number;
	};

	/** 延迟统计（毫秒） */
	latency: {
		llm: number[];
		toolExecution: number[];
		contextAssembly: number[];
	};

	/** 缓存统计 */
	cache: {
		hits: number;
		misses: number;
		hitRate: number;
	};

	/** 错误统计 */
	errors: {
		total: number;
		recovered: number;
		recoveryRate: number;
	};

	/** 会话统计 */
	sessions: {
		active: number;
		total: number;
		averageDuration: number;
	};
}

export interface MetricEvent {
	name: string;
	value: number;
	timestamp: number;
	tags?: Record<string, string>;
}

export interface Timer {
	name: string;
	startTime: number;
	stop: () => number;
}

export interface PerformanceReport {
	timestamp: number;
	metrics: PerformanceMetrics;
	summary: string;
}
