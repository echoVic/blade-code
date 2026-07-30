/**
 * 环境变量加载和管理模块
 *
 * 职责：
 * - 加载 .env 文件
 * - 解析环境变量插值
 * - 环境变量优先级管理
 * - 支持 .env.local、.env.production 等变体
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getCwd } from '../utils/cwd.js';
import * as os from 'node:os';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.CONFIG);

interface EnvLoadOptions {
	override?: boolean; // 是否覆盖已存在的环境变量
	path?: string; // 自定义 .env 文件路径
	encoding?: BufferEncoding; // 文件编码
}

/**
 * 加载环境变量文件
 *
 * 优先级（从高到低）：
 * 1. .env.local (git ignored, 本地开发)
 * 2. .env.[mode] (如 .env.production)
 * 3. .env
 * 4. ~/.blade/.env (全局配置)
 */
export async function loadEnvFiles(mode?: string): Promise<Record<string, string>> {
	const cwd = getCwd();
	const homeEnvPath = path.join(os.homedir(), '.blade', '.env');

	const envFiles = [
		homeEnvPath, // 全局环境变量
		path.join(cwd, '.env'), // 项目基础环境变量
		mode ? path.join(cwd, `.env.${mode}`) : null, // 模式特定环境变量
		path.join(cwd, '.env.local'), // 本地环境变量（优先级最高）
	].filter((p): p is string => p !== null);

	let mergedEnv: Record<string, string> = {};

	for (const envFile of envFiles) {
		try {
			const env = await loadEnvFile(envFile, { override: true });
			mergedEnv = { ...mergedEnv, ...env };
			logger.debug(`已加载环境变量文件: ${envFile}`);
		} catch (error) {
			// 文件不存在是正常的，不报错
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(`加载环境变量文件失败: ${envFile}`, error);
			}
		}
	}

	return mergedEnv;
}

/**
 * 加载单个 .env 文件
 */
export async function loadEnvFile(
	filePath: string,
	options: EnvLoadOptions = {}
): Promise<Record<string, string>> {
	const { override = false, encoding = 'utf8' } = options;

	const content = await fs.readFile(filePath, encoding);
	const env = parseEnvContent(content);

	// 应用到 process.env
	for (const [key, value] of Object.entries(env)) {
		if (override || process.env[key] === undefined) {
			process.env[key] = value;
		}
	}

	return env;
}

/**
 * 解析 .env 文件内容
 *
 * 支持格式：
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted'
 * - # 注释
 * - 空行
 * - export KEY=value
 * - 多行值（引号包裹）
 */
export function parseEnvContent(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	const lines = content.split(/\r?\n/);

	let currentKey: string | null = null;
	let currentValue = '';
	let inMultiline = false;
	let quoteChar: '"' | "'" | null = null;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// 跳过空行和注释（只在非多行模式下）
		if (!inMultiline) {
			line = line.trim();
			if (line === '' || line.startsWith('#')) {
				continue;
			}

			// 移除 export 前缀
			if (line.startsWith('export ')) {
				line = line.slice(7);
			}
		}

		// 解析 KEY=VALUE
		if (!inMultiline) {
			const matchResult = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
			if (!matchResult) {
				continue;
			}

			currentKey = matchResult[1];
			let value = matchResult[2];

			// 检查是否是引号包裹的值
			if (value.startsWith('"') || value.startsWith("'")) {
				quoteChar = value[0] as '"' | "'";
				value = value.slice(1);

				// 检查是否在同一行结束
				if (value.endsWith(quoteChar)) {
					value = value.slice(0, -1);
					env[currentKey] = value;
					currentKey = null;
					quoteChar = null;
				} else {
					// 多行值
					inMultiline = true;
					currentValue = value + '\n';
				}
			} else {
				// 无引号的简单值
				env[currentKey] = value;
				currentKey = null;
			}
		} else {
			// 多行模式：继续收集值
			if (line.endsWith(quoteChar!)) {
				currentValue += line.slice(0, -1);
				env[currentKey!] = currentValue;
				currentKey = null;
				currentValue = '';
				inMultiline = false;
				quoteChar = null;
			} else {
				currentValue += line + '\n';
			}
		}
	}

	return env;
}

/**
 * 解析配置中的环境变量插值
 *
 * 支持格式：
 * - $VAR
 * - ${VAR}
 * - ${VAR:-default}
 * - ${VAR:?error message}
 */
export function resolveEnvInterpolation(
	value: string,
	env: Record<string, string> = process.env as Record<string, string>
): string {
	const pattern = /\$\{?([A-Z_][A-Z0-9_]*)(:-([^}]+)|:\?([^}]+))?\}?/g;

	return value.replace(pattern, (match, varName, modifier, defaultValue, errorMessage) => {
		const envValue = env[varName];

		if (envValue !== undefined) {
			return envValue;
		}

		// ${VAR:-default} - 使用默认值
		if (defaultValue !== undefined) {
			return defaultValue;
		}

		// ${VAR:?error} - 抛出错误
		if (errorMessage !== undefined) {
			throw new Error(`环境变量 ${varName} 未设置: ${errorMessage}`);
		}

		// 保持原样
		return match;
	});
}

/**
 * 递归解析对象中的所有环境变量插值
 */
export function resolveObjectEnvInterpolation<T>(
	obj: T,
	env?: Record<string, string>
): T {
	if (typeof obj === 'string') {
		return resolveEnvInterpolation(obj, env) as T;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => resolveObjectEnvInterpolation(item, env)) as T;
	}

	if (obj !== null && typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = resolveObjectEnvInterpolation(value, env);
		}
		return result as T;
	}

	return obj;
}

/**
 * 生成 .env 文件内容
 */
export function stringifyEnv(env: Record<string, string>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(env)) {
		// 需要引号的情况：包含空格、特殊字符、换行等
		if (value.includes(' ') || value.includes('\n') || value.includes('#')) {
			const escapedValue = value.replace(/\n/g, '\\n').replace(/"/g, '\\"');
			lines.push(`${key}="${escapedValue}"`);
		} else {
			lines.push(`${key}=${value}`);
		}
	}

	return lines.join('\n');
}

/**
 * 保存环境变量到文件
 */
export async function saveEnvFile(
	filePath: string,
	env: Record<string, string>
): Promise<void> {
	const content = stringifyEnv(env);
	await fs.writeFile(filePath, content, 'utf8');
	logger.debug(`已保存环境变量文件: ${filePath}`);
}

/**
 * 验证必需的环境变量
 */
export function validateRequiredEnv(
	required: string[],
	env: Record<string, string> = process.env as Record<string, string>
): { valid: boolean; missing: string[] } {
	const missing = required.filter((key) => !env[key]);
	return {
		valid: missing.length === 0,
		missing,
	};
}
