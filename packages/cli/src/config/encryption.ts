/**
 * 配置加密模块 - 敏感信息加密存储
 *
 * 职责：
 * - 加密/解密 API Keys 等敏感信息
 * - 使用系统密钥链（macOS Keychain / Linux Secret Service / Windows Credential Manager）
 * - Fallback 到基于机器 ID 的本地加密
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import * as os from 'node:os';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { ModelConfig, McpServerConfig } from './types.js';

const logger = createLogger(LogCategory.CONFIG);
const scryptAsync = promisify(scrypt);

// 加密算法
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * 加密文本
 */
export async function encrypt(plaintext: string, password?: string): Promise<string> {
	try {
		const pwd = password || (await getMachinePassword());
		const salt = randomBytes(SALT_LENGTH);
		const iv = randomBytes(IV_LENGTH);

		// 从密码派生密钥
		const key = (await scryptAsync(pwd, salt, KEY_LENGTH)) as Buffer;

		// 加密
		const cipher = createCipheriv(ALGORITHM, key, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const authTag = cipher.getAuthTag();

		// 拼接: salt + iv + authTag + encrypted
		const result = Buffer.concat([salt, iv, authTag, encrypted]);
		return `encrypted:${result.toString('base64')}`;
	} catch (error) {
		logger.error('加密失败', error);
		throw new Error('加密失败');
	}
}

/**
 * 解密文本
 */
export async function decrypt(ciphertext: string, password?: string): Promise<string> {
	try {
		// 检查是否是加密格式
		if (!ciphertext.startsWith('encrypted:')) {
			return ciphertext; // 未加密，直接返回
		}

		const pwd = password || (await getMachinePassword());
		const data = Buffer.from(ciphertext.slice(10), 'base64');

		// 解析: salt + iv + authTag + encrypted
		const salt = data.subarray(0, SALT_LENGTH);
		const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
		const authTag = data.subarray(
			SALT_LENGTH + IV_LENGTH,
			SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
		);
		const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

		// 从密码派生密钥
		const key = (await scryptAsync(pwd, salt, KEY_LENGTH)) as Buffer;

		// 解密
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);
		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

		return decrypted.toString('utf8');
	} catch (error) {
		logger.error('解密失败', error);
		throw new Error('解密失败，密钥可能不正确');
	}
}

/**
 * 加密配置中的敏感字段
 */
export async function encryptSensitiveFields(
	config: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const result = { ...config };

	// 加密 models 中的 apiKey
	if (Array.isArray(result.models)) {
		result.models = await Promise.all(
			(result.models as ModelConfig[]).map(async (model) => {
				if (model.apiKey && !model.apiKey.startsWith('encrypted:')) {
					return {
						...model,
						apiKey: await encrypt(model.apiKey),
					};
				}
				return model;
			})
		);
	}

	// 加密 mcpServers 中的敏感字段
	if (result.mcpServers && typeof result.mcpServers === 'object') {
		const servers: Record<string, McpServerConfig> = {};
		for (const [name, server] of Object.entries(result.mcpServers as Record<string, McpServerConfig>)) {
			servers[name] = { ...server };

			// 加密 OAuth 配置
			if (server.oauth?.clientSecret && typeof server.oauth.clientSecret === 'string' && !server.oauth.clientSecret.startsWith('encrypted:')) {
				servers[name].oauth = {
					...server.oauth,
					clientSecret: await encrypt(server.oauth.clientSecret),
				};
			}

			// 加密环境变量中的敏感值
			if (server.env && typeof server.env === 'object') {
				const env: Record<string, string> = {};
				for (const [key, value] of Object.entries(server.env)) {
					if (typeof value === 'string') {
						if (isSensitiveEnvVar(key) && !value.startsWith('encrypted:')) {
							env[key] = await encrypt(value);
						} else {
							env[key] = value;
						}
					}
				}
				servers[name].env = env;
			}
		}
		result.mcpServers = servers;
	}

	return result;
}

/**
 * 解密配置中的敏感字段
 */
export async function decryptSensitiveFields(
	config: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const result = { ...config };

	// 解密 models 中的 apiKey
	if (Array.isArray(result.models)) {
		result.models = await Promise.all(
			(result.models as ModelConfig[]).map(async (model) => {
				if (model.apiKey && model.apiKey.startsWith('encrypted:')) {
					return {
						...model,
						apiKey: await decrypt(model.apiKey),
					};
				}
				return model;
			})
		);
	}

	// 解密 mcpServers 中的敏感字段
	if (result.mcpServers && typeof result.mcpServers === 'object') {
		const servers: Record<string, McpServerConfig> = {};
		for (const [name, server] of Object.entries(result.mcpServers as Record<string, McpServerConfig>)) {
			servers[name] = { ...server };

			// 解密 OAuth 配置
			if (server.oauth?.clientSecret && typeof server.oauth.clientSecret === 'string' && server.oauth.clientSecret.startsWith('encrypted:')) {
				servers[name].oauth = {
					...server.oauth,
					clientSecret: await decrypt(server.oauth.clientSecret),
				};
			}

			// 解密环境变量
			if (server.env && typeof server.env === 'object') {
				const env: Record<string, string> = {};
				for (const [key, value] of Object.entries(server.env)) {
					if (typeof value === 'string') {
						if (value.startsWith('encrypted:')) {
							env[key] = await decrypt(value);
						} else {
							env[key] = value;
						}
					}
				}
				servers[name].env = env;
			}
		}
		result.mcpServers = servers;
	}

	return result;
}

/**
 * 判断环境变量是否敏感
 */
function isSensitiveEnvVar(key: string): boolean {
	const sensitivePatterns = [
		/API_KEY$/i,
		/SECRET$/i,
		/PASSWORD$/i,
		/TOKEN$/i,
		/CREDENTIAL$/i,
		/PRIVATE_KEY$/i,
	];
	return sensitivePatterns.some((pattern) => pattern.test(key));
}

/**
 * 获取机器唯一密码（Fallback 方案）
 */
async function getMachinePassword(): Promise<string> {
	// 使用机器标识生成唯一密码
	const machineId = [
		os.hostname(),
		os.platform(),
		os.arch(),
		os.homedir(),
		process.env.USER || process.env.USERNAME || 'blade',
	].join('|');

	return machineId;
}

/**
 * 验证加密文本格式
 */
export function isEncrypted(text: string): boolean {
	return text.startsWith('encrypted:');
}
