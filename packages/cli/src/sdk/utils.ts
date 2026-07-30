/**
 * SDK 工具函数
 */

/**
 * 格式化 Markdown 文本
 */
export function formatMarkdown(text: string): string {
	// 移除多余的空行
	text = text.replace(/\n{3,}/g, '\n\n');

	// 确保代码块前后有空行
	text = text.replace(/([^\n])\n```/g, '$1\n\n```');
	text = text.replace(/```\n([^\n])/g, '```\n\n$1');

	// 确保标题前后有空行
	text = text.replace(/([^\n])\n(#{1,6} )/g, '$1\n\n$2');
	text = text.replace(/(#{1,6} .+)\n([^\n#])/g, '$1\n\n$2');

	return text.trim();
}

/**
 * 解析命令（如 slash 命令）
 */
export function parseCommand(input: string): {
	command: string | null;
	args: string;
} {
	const match = input.match(/^\/(\w+)(?:\s+(.*))?$/);
	if (!match) {
		return { command: null, args: input };
	}
	return {
		command: match[1],
		args: match[2] || '',
	};
}

/**
 * 验证配置对象
 */
export function validateConfig(config: Record<string, any>): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// 基本验证逻辑
	if (!config.apiKey && !config.baseURL) {
		errors.push('必须提供 apiKey 或 baseURL');
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * 估算文本的 Token 数量（粗略估计）
 */
export function estimateTokens(text: string): number {
	// 英文：约 4 字符 = 1 token
	// 中文：约 2 字符 = 1 token
	const chineseChars = (text.match(/[一-龥]/g) || []).length;
	const otherChars = text.length - chineseChars;

	return Math.ceil(chineseChars / 2 + otherChars / 4);
}

/**
 * 截断文本到指定 Token 数
 */
export function truncateToTokens(text: string, maxTokens: number): string {
	const estimatedTokens = estimateTokens(text);

	if (estimatedTokens <= maxTokens) {
		return text;
	}

	// 粗略计算需要保留的字符数
	const ratio = maxTokens / estimatedTokens;
	const targetLength = Math.floor(text.length * ratio);

	return text.substring(0, targetLength) + '...';
}
