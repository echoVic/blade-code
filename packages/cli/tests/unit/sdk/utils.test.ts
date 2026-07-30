/**
 * SDK 工具函数测试
 */

import { describe, it, expect } from 'vitest';
import {
	formatMarkdown,
	parseCommand,
	validateConfig,
	estimateTokens,
	truncateToTokens,
} from '../../../src/sdk/utils';

describe('SDK Utils', () => {
	describe('formatMarkdown', () => {
		it('应该移除多余的空行', () => {
			const input = 'line1\n\n\n\nline2';
			const output = formatMarkdown(input);
			expect(output).toBe('line1\n\nline2');
		});

		it('应该确保代码块前后有空行', () => {
			const input = 'text\n```\ncode\n```\ntext';
			const output = formatMarkdown(input);
			expect(output).toContain('\n\n```');
			expect(output).toContain('```\n\n');
		});

		it('应该确保标题前后有空行', () => {
			const input = 'text\n# Title\ntext';
			const output = formatMarkdown(input);
			expect(output).toContain('\n\n# Title\n\n');
		});

		it('应该处理多级标题', () => {
			const input = 'text\n## Subtitle\ntext';
			const output = formatMarkdown(input);
			expect(output).toContain('\n\n## Subtitle\n\n');
		});

		it('应该去除首尾空白', () => {
			const input = '  \n  text  \n  ';
			const output = formatMarkdown(input);
			expect(output).toBe('text');
		});
	});

	describe('parseCommand', () => {
		it('应该解析斜杠命令', () => {
			const result = parseCommand('/help');
			expect(result.command).toBe('help');
			expect(result.args).toBe('');
		});

		it('应该解析带参数的命令', () => {
			const result = parseCommand('/search query text');
			expect(result.command).toBe('search');
			expect(result.args).toBe('query text');
		});

		it('应该处理非命令文本', () => {
			const result = parseCommand('normal text');
			expect(result.command).toBeNull();
			expect(result.args).toBe('normal text');
		});

		it('应该处理空命令', () => {
			const result = parseCommand('/');
			expect(result.command).toBeNull();
		});

		it('应该只识别单词字符的命令', () => {
			const result = parseCommand('/test-command');
			expect(result.command).toBeNull();
		});
	});

	describe('validateConfig', () => {
		it('应该验证有效配置', () => {
			const config = { apiKey: 'test-key' };
			const result = validateConfig(config);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('应该拒绝空配置', () => {
			const config = {};
			const result = validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('应该接受带 baseURL 的配置', () => {
			const config = { baseURL: 'https://api.example.com' };
			const result = validateConfig(config);
			expect(result.valid).toBe(true);
		});
	});

	describe('estimateTokens', () => {
		it('应该估算英文文本的 token 数', () => {
			const text = 'Hello world';
			const tokens = estimateTokens(text);
			expect(tokens).toBeGreaterThan(0);
			expect(tokens).toBeLessThan(10);
		});

		it('应该估算中文文本的 token 数', () => {
			const text = '你好世界';
			const tokens = estimateTokens(text);
			expect(tokens).toBeGreaterThan(0);
			expect(tokens).toBeLessThan(10);
		});

		it('应该估算混合文本的 token 数', () => {
			const text = 'Hello 世界';
			const tokens = estimateTokens(text);
			expect(tokens).toBeGreaterThan(0);
		});

		it('应该处理空文本', () => {
			const tokens = estimateTokens('');
			expect(tokens).toBe(0);
		});

		it('应该正确估算中文和英文混合文本', () => {
			const english = 'hello';
			const chinese = '你好世界';
			const englishTokens = estimateTokens(english);
			const chineseTokens = estimateTokens(chinese);
			// 两者都应该返回合理的值
			expect(englishTokens).toBeGreaterThan(0);
			expect(chineseTokens).toBeGreaterThan(0);
		});
	});

	describe('truncateToTokens', () => {
		it('应该截断长文本', () => {
			const text = 'a'.repeat(1000);
			const truncated = truncateToTokens(text, 10);
			expect(truncated.length).toBeLessThan(text.length);
			expect(truncated).toContain('...');
		});

		it('应该保持短文本不变', () => {
			const text = 'short text';
			const truncated = truncateToTokens(text, 100);
			expect(truncated).toBe(text);
		});

		it('应该根据 token 数截断', () => {
			const text = 'word '.repeat(100);
			const truncated = truncateToTokens(text, 10);
			expect(estimateTokens(truncated)).toBeLessThanOrEqual(15); // 允许一些误差
		});

		it('应该处理空文本', () => {
			const truncated = truncateToTokens('', 10);
			expect(truncated).toBe('');
		});

		it('应该处理中文文本', () => {
			const text = '这是一段很长的中文文本，'.repeat(50);
			const truncated = truncateToTokens(text, 20);
			expect(truncated.length).toBeLessThan(text.length);
		});
	});
});
