/**
 * 统一错误处理系统
 *
 * 提供标准化的错误类型、错误恢复机制和错误报告
 */

/**
 * Blade 基础错误类
 */
export class BladeError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly recoverable: boolean = false,
		public readonly context?: Record<string, any>,
	) {
		super(message);
		this.name = 'BladeError';
		Error.captureStackTrace?.(this, this.constructor);
	}

	/**
	 * 转换为可序列化的对象
	 */
	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			recoverable: this.recoverable,
			context: this.context,
			stack: this.stack,
		};
	}
}

/**
 * 工具执行错误
 */
export class ToolExecutionError extends BladeError {
	constructor(
		message: string,
		public readonly toolName: string,
		public readonly originalError?: Error,
		recoverable = true,
	) {
		super(message, 'TOOL_EXECUTION_ERROR', recoverable, {
			toolName,
			originalError: originalError?.message,
		});
		this.name = 'ToolExecutionError';
	}
}

/**
 * 配置错误
 */
export class ConfigurationError extends BladeError {
	constructor(message: string, public readonly configKey?: string, recoverable = false) {
		super(message, 'CONFIGURATION_ERROR', recoverable, { configKey });
		this.name = 'ConfigurationError';
	}
}

/**
 * 网络错误
 */
export class NetworkError extends BladeError {
	constructor(
		message: string,
		public readonly statusCode?: number,
		public readonly endpoint?: string,
		recoverable = true,
	) {
		super(message, 'NETWORK_ERROR', recoverable, {
			statusCode,
			endpoint,
		});
		this.name = 'NetworkError';
	}
}

/**
 * 验证错误
 */
export class ValidationError extends BladeError {
	constructor(message: string, public readonly field?: string, recoverable = false) {
		super(message, 'VALIDATION_ERROR', recoverable, { field });
		this.name = 'ValidationError';
	}
}

/**
 * Agent 执行错误
 */
export class AgentExecutionError extends BladeError {
	constructor(message: string, public readonly phase?: string, recoverable = true) {
		super(message, 'AGENT_EXECUTION_ERROR', recoverable, { phase });
		this.name = 'AgentExecutionError';
	}
}

/**
 * 文件系统错误
 */
export class FileSystemError extends BladeError {
	constructor(
		message: string,
		public readonly filePath?: string,
		public readonly operation?: string,
		recoverable = true,
	) {
		super(message, 'FILE_SYSTEM_ERROR', recoverable, {
			filePath,
			operation,
		});
		this.name = 'FileSystemError';
	}
}

/**
 * MCP 协议错误
 */
export class MCPError extends BladeError {
	constructor(message: string, public readonly serverName?: string, recoverable = true) {
		super(message, 'MCP_ERROR', recoverable, { serverName });
		this.name = 'MCPError';
	}
}

/**
 * 权限错误
 */
export class PermissionError extends BladeError {
	constructor(
		message: string,
		public readonly resource?: string,
		recoverable = false,
	) {
		super(message, 'PERMISSION_ERROR', recoverable, { resource });
		this.name = 'PermissionError';
	}
}

/**
 * API 限流错误
 */
export class RateLimitError extends BladeError {
	constructor(
		message: string,
		public readonly retryAfter?: number,
		recoverable = true,
	) {
		super(message, 'RATE_LIMIT_ERROR', recoverable, { retryAfter });
		this.name = 'RateLimitError';
	}
}

/**
 * Token 限制错误
 */
export class TokenLimitError extends BladeError {
	constructor(
		message: string,
		public readonly currentTokens?: number,
		public readonly maxTokens?: number,
		recoverable = false,
	) {
		super(message, 'TOKEN_LIMIT_ERROR', recoverable, {
			currentTokens,
			maxTokens,
		});
		this.name = 'TokenLimitError';
	}
}

/**
 * 检查是否是 Blade 错误
 */
export function isBladeError(error: unknown): error is BladeError {
	return error instanceof BladeError;
}

/**
 * 将任意错误转换为 BladeError
 */
export function toBladeError(error: unknown): BladeError {
	if (isBladeError(error)) {
		return error;
	}

	if (error instanceof Error) {
		return new BladeError(error.message, 'UNKNOWN_ERROR', true, {
			originalName: error.name,
			originalStack: error.stack,
		});
	}

	return new BladeError(
		String(error),
		'UNKNOWN_ERROR',
		true,
	);
}

/**
 * 错误代码枚举
 */
export enum ErrorCode {
	// 工具相关
	TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
	TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
	TOOL_VALIDATION_ERROR = 'TOOL_VALIDATION_ERROR',

	// 配置相关
	CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
	INVALID_CONFIG = 'INVALID_CONFIG',
	MISSING_CONFIG = 'MISSING_CONFIG',

	// 网络相关
	NETWORK_ERROR = 'NETWORK_ERROR',
	TIMEOUT_ERROR = 'TIMEOUT_ERROR',
	CONNECTION_ERROR = 'CONNECTION_ERROR',

	// 验证相关
	VALIDATION_ERROR = 'VALIDATION_ERROR',
	INVALID_INPUT = 'INVALID_INPUT',
	INVALID_PARAMETER = 'INVALID_PARAMETER',

	// Agent 相关
	AGENT_EXECUTION_ERROR = 'AGENT_EXECUTION_ERROR',
	AGENT_TIMEOUT = 'AGENT_TIMEOUT',
	AGENT_ABORTED = 'AGENT_ABORTED',

	// 文件系统相关
	FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
	FILE_NOT_FOUND = 'FILE_NOT_FOUND',
	FILE_ACCESS_DENIED = 'FILE_ACCESS_DENIED',

	// MCP 相关
	MCP_ERROR = 'MCP_ERROR',
	MCP_CONNECTION_ERROR = 'MCP_CONNECTION_ERROR',
	MCP_PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR',

	// 权限相关
	PERMISSION_ERROR = 'PERMISSION_ERROR',
	PERMISSION_DENIED = 'PERMISSION_DENIED',

	// 限流相关
	RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
	TOKEN_LIMIT_ERROR = 'TOKEN_LIMIT_ERROR',

	// 未知错误
	UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
