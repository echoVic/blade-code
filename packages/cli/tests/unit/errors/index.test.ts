/**
 * 错误处理系统测试
 */

import { describe, expect, it } from 'vitest';
import {
	AgentExecutionError,
	BladeError,
	ConfigurationError,
	FileSystemError,
	isBladeError,
	MCPError,
	NetworkError,
	PermissionError,
	RateLimitError,
	toBladeError,
	TokenLimitError,
	ToolExecutionError,
	ValidationError,
} from '../../../src/errors/index.js';

describe('错误处理系统', () => {
	describe('BladeError', () => {
		it('应该创建基础错误', () => {
			const error = new BladeError('测试错误', 'TEST_ERROR', true, {
				key: 'value',
			});

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe('测试错误');
			expect(error.code).toBe('TEST_ERROR');
			expect(error.recoverable).toBe(true);
			expect(error.context).toEqual({ key: 'value' });
			expect(error.name).toBe('BladeError');
		});

		it('应该可以序列化为 JSON', () => {
			const error = new BladeError('测试错误', 'TEST_ERROR', true);
			const json = error.toJSON();

			expect(json).toHaveProperty('name', 'BladeError');
			expect(json).toHaveProperty('message', '测试错误');
			expect(json).toHaveProperty('code', 'TEST_ERROR');
			expect(json).toHaveProperty('recoverable', true);
			expect(json).toHaveProperty('stack');
		});
	});

	describe('ToolExecutionError', () => {
		it('应该创建工具执行错误', () => {
			const originalError = new Error('原始错误');
			const error = new ToolExecutionError(
				'工具执行失败',
				'ReadFile',
				originalError,
				true,
			);

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('工具执行失败');
			expect(error.code).toBe('TOOL_EXECUTION_ERROR');
			expect(error.toolName).toBe('ReadFile');
			expect(error.originalError).toBe(originalError);
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('ToolExecutionError');
		});
	});

	describe('ConfigurationError', () => {
		it('应该创建配置错误', () => {
			const error = new ConfigurationError('配置无效', 'apiKey', false);

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('配置无效');
			expect(error.code).toBe('CONFIGURATION_ERROR');
			expect(error.configKey).toBe('apiKey');
			expect(error.recoverable).toBe(false);
			expect(error.name).toBe('ConfigurationError');
		});
	});

	describe('NetworkError', () => {
		it('应该创建网络错误', () => {
			const error = new NetworkError('请求失败', 500, 'https://api.example.com');

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('请求失败');
			expect(error.code).toBe('NETWORK_ERROR');
			expect(error.statusCode).toBe(500);
			expect(error.endpoint).toBe('https://api.example.com');
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('NetworkError');
		});
	});

	describe('ValidationError', () => {
		it('应该创建验证错误', () => {
			const error = new ValidationError('字段验证失败', 'email');

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('字段验证失败');
			expect(error.code).toBe('VALIDATION_ERROR');
			expect(error.field).toBe('email');
			expect(error.recoverable).toBe(false);
			expect(error.name).toBe('ValidationError');
		});
	});

	describe('AgentExecutionError', () => {
		it('应该创建 Agent 执行错误', () => {
			const error = new AgentExecutionError('Agent 执行失败', 'planning');

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('Agent 执行失败');
			expect(error.code).toBe('AGENT_EXECUTION_ERROR');
			expect(error.phase).toBe('planning');
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('AgentExecutionError');
		});
	});

	describe('FileSystemError', () => {
		it('应该创建文件系统错误', () => {
			const error = new FileSystemError(
				'文件读取失败',
				'/path/to/file',
				'read',
			);

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('文件读取失败');
			expect(error.code).toBe('FILE_SYSTEM_ERROR');
			expect(error.filePath).toBe('/path/to/file');
			expect(error.operation).toBe('read');
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('FileSystemError');
		});
	});

	describe('MCPError', () => {
		it('应该创建 MCP 错误', () => {
			const error = new MCPError('MCP 服务器连接失败', 'my-server');

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('MCP 服务器连接失败');
			expect(error.code).toBe('MCP_ERROR');
			expect(error.serverName).toBe('my-server');
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('MCPError');
		});
	});

	describe('PermissionError', () => {
		it('应该创建权限错误', () => {
			const error = new PermissionError('无权访问', '/etc/passwd');

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('无权访问');
			expect(error.code).toBe('PERMISSION_ERROR');
			expect(error.resource).toBe('/etc/passwd');
			expect(error.recoverable).toBe(false);
			expect(error.name).toBe('PermissionError');
		});
	});

	describe('RateLimitError', () => {
		it('应该创建限流错误', () => {
			const error = new RateLimitError('请求过于频繁', 5000);

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('请求过于频繁');
			expect(error.code).toBe('RATE_LIMIT_ERROR');
			expect(error.retryAfter).toBe(5000);
			expect(error.recoverable).toBe(true);
			expect(error.name).toBe('RateLimitError');
		});
	});

	describe('TokenLimitError', () => {
		it('应该创建 token 限制错误', () => {
			const error = new TokenLimitError('超过 token 限制', 10000, 8000);

			expect(error).toBeInstanceOf(BladeError);
			expect(error.message).toBe('超过 token 限制');
			expect(error.code).toBe('TOKEN_LIMIT_ERROR');
			expect(error.currentTokens).toBe(10000);
			expect(error.maxTokens).toBe(8000);
			expect(error.recoverable).toBe(false);
			expect(error.name).toBe('TokenLimitError');
		});
	});

	describe('isBladeError', () => {
		it('应该正确识别 BladeError', () => {
			const bladeError = new BladeError('测试', 'TEST');
			const normalError = new Error('测试');

			expect(isBladeError(bladeError)).toBe(true);
			expect(isBladeError(normalError)).toBe(false);
			expect(isBladeError('string')).toBe(false);
			expect(isBladeError(null)).toBe(false);
		});

		it('应该识别所有 BladeError 子类', () => {
			expect(isBladeError(new ToolExecutionError('测试', 'tool'))).toBe(true);
			expect(isBladeError(new ConfigurationError('测试'))).toBe(true);
			expect(isBladeError(new NetworkError('测试'))).toBe(true);
			expect(isBladeError(new ValidationError('测试'))).toBe(true);
		});
	});

	describe('toBladeError', () => {
		it('应该保留 BladeError', () => {
			const error = new BladeError('测试', 'TEST');
			const converted = toBladeError(error);

			expect(converted).toBe(error);
		});

		it('应该转换普通 Error', () => {
			const error = new Error('测试错误');
			const converted = toBladeError(error);

			expect(converted).toBeInstanceOf(BladeError);
			expect(converted.message).toBe('测试错误');
			expect(converted.code).toBe('UNKNOWN_ERROR');
			expect(converted.recoverable).toBe(true);
			expect(converted.context?.originalName).toBe('Error');
		});

		it('应该转换字符串', () => {
			const converted = toBladeError('测试错误');

			expect(converted).toBeInstanceOf(BladeError);
			expect(converted.message).toBe('测试错误');
			expect(converted.code).toBe('UNKNOWN_ERROR');
			expect(converted.recoverable).toBe(true);
		});

		it('应该转换其他类型', () => {
			const converted = toBladeError({ message: '对象错误' });

			expect(converted).toBeInstanceOf(BladeError);
			expect(converted.code).toBe('UNKNOWN_ERROR');
		});
	});
});
