/**
 * 配置验证和迁移模块
 *
 * 职责：
 * - 配置结构验证
 * - 配置版本迁移
 * - 配置完整性检查
 */

import { z } from 'zod';
import type { BladeConfig, ModelConfig, McpServerConfig } from './types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.CONFIG);

// 配置版本号
const CONFIG_VERSION = '2.0.0';

// ============================================
// Zod 验证模式
// ============================================

const ModelConfigSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	provider: z.string().min(1),
	apiKey: z.string().min(1),
	baseUrl: z.string().url(),
	model: z.string().min(1),
	temperature: z.number().min(0).max(2).optional(),
	maxContextTokens: z.number().positive().optional(),
	maxOutputTokens: z.number().positive().optional(),
	topP: z.number().min(0).max(1).optional(),
	topK: z.number().positive().optional(),
	supportsThinking: z.boolean().optional(),
	thinkingBudget: z.number().positive().optional(),
	apiVersion: z.string().optional(),
	projectId: z.string().optional(),
});

const McpServerConfigSchema = z.object({
	type: z.enum(['stdio', 'sse', 'http']),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
	url: z.string().url().optional(),
	headers: z.record(z.string()).optional(),
	timeout: z.number().positive().optional(),
	oauth: z
		.object({
			enabled: z.boolean().optional(),
			clientId: z.string().optional(),
			clientSecret: z.string().optional(),
			authorizationUrl: z.string().url().optional(),
			tokenUrl: z.string().url().optional(),
			scopes: z.array(z.string()).optional(),
			redirectUri: z.string().url().optional(),
		})
		.optional(),
	healthCheck: z
		.object({
			enabled: z.boolean().optional(),
			interval: z.number().positive().optional(),
			timeout: z.number().positive().optional(),
			failureThreshold: z.number().positive().optional(),
		})
		.optional(),
});

const BladeConfigSchema = z.object({
	// 版本
	version: z.string().optional(),

	// 模型配置
	currentModelId: z.string(),
	models: z.array(ModelConfigSchema).min(1),

	// 全局参数
	temperature: z.number().min(0).max(2),
	maxContextTokens: z.number().positive(),
	maxOutputTokens: z.number().positive().optional(),
	stream: z.boolean(),
	topP: z.number().min(0).max(1),
	topK: z.number().positive(),
	timeout: z.number().positive(),

	// UI
	theme: z.string(),
	uiTheme: z.any(),
	language: z.string(),
	fontSize: z.number().positive(),

	// 通用设置
	autoSaveSessions: z.boolean(),
	notifyBuild: z.boolean(),
	notifyErrors: z.boolean(),
	notifySounds: z.boolean(),
	privacyTelemetry: z.boolean(),
	privacyCrash: z.boolean(),

	// 核心
	debug: z.union([z.boolean(), z.string()]),

	// MCP
	mcpEnabled: z.boolean(),
	mcpServers: z.record(McpServerConfigSchema),

	// 权限
	permissions: z.object({
		allow: z.array(z.string()),
		ask: z.array(z.string()),
		deny: z.array(z.string()),
	}),
	permissionMode: z.enum(['default', 'autoEdit', 'yolo', 'plan', 'spec']),

	// Hooks
	hooks: z.any(),

	// 环境变量
	env: z.record(z.string()),

	// 其他
	disableAllHooks: z.boolean(),
	maxTurns: z.number(),
});

/**
 * 验证配置
 */
export function validateConfig(config: unknown): { valid: boolean; errors: string[] } {
	try {
		BladeConfigSchema.parse(config);
		return { valid: true, errors: [] };
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errors = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
			return { valid: false, errors };
		}
		return { valid: false, errors: ['未知验证错误'] };
	}
}

/**
 * 验证模型配置
 */
export function validateModelConfig(
	model: unknown
): { valid: boolean; errors: string[] } {
	try {
		ModelConfigSchema.parse(model);
		return { valid: true, errors: [] };
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errors = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
			return { valid: false, errors };
		}
		return { valid: false, errors: ['未知验证错误'] };
	}
}

/**
 * 验证 MCP 服务器配置
 */
export function validateMcpServerConfig(
	server: unknown
): { valid: boolean; errors: string[] } {
	try {
		McpServerConfigSchema.parse(server);
		return { valid: true, errors: [] };
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errors = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
			return { valid: false, errors };
		}
		return { valid: false, errors: ['未知验证错误'] };
	}
}

/**
 * 配置迁移 - 从旧版本迁移到新版本
 */
export async function migrateConfig(config: Record<string, unknown>): Promise<BladeConfig> {
	const currentVersion = (config.version as string) || '1.0.0';

	logger.info(`配置迁移: ${currentVersion} -> ${CONFIG_VERSION}`);

	let migratedConfig = { ...config };

	// 1.x -> 2.0 迁移
	if (compareVersion(currentVersion, '2.0.0') < 0) {
		migratedConfig = await migrateFrom1xTo2x(migratedConfig);
	}

	// 设置最新版本
	migratedConfig.version = CONFIG_VERSION;

	return migratedConfig as BladeConfig;
}

/**
 * 从 1.x 迁移到 2.0
 */
async function migrateFrom1xTo2x(config: Record<string, unknown>): Promise<Record<string, unknown>> {
	const migrated = { ...config };

	// 迁移 API 配置到 models 数组（如果是旧格式）
	if (config.apiKey && !config.models) {
		logger.info('检测到旧版 API 配置，迁移到 models 数组');
		migrated.models = [
			{
				id: `model-${Date.now()}`,
				name: '默认模型',
				provider: config.provider || 'openai-compatible',
				apiKey: config.apiKey,
				baseUrl: config.baseUrl || 'https://api.openai.com/v1',
				model: config.model || 'gpt-4',
			},
		];
		migrated.currentModelId = migrated.models[0].id;

		// 删除旧字段
		delete migrated.apiKey;
		delete migrated.provider;
		delete migrated.baseUrl;
		delete migrated.model;
	}

	// 迁移权限配置（如果是旧格式）
	if (config.allowedTools && !config.permissions) {
		logger.info('迁移旧版权限配置');
		migrated.permissions = {
			allow: config.allowedTools || [],
			ask: [],
			deny: config.disallowedTools || [],
		};
		delete migrated.allowedTools;
		delete migrated.disallowedTools;
	}

	// 添加新字段默认值
	if (!migrated.hooks) {
		migrated.hooks = {};
	}
	if (!migrated.env) {
		migrated.env = {};
	}
	if (!migrated.mcpServers) {
		migrated.mcpServers = {};
	}

	return migrated;
}

/**
 * 比较版本号
 * @returns -1: v1 < v2, 0: v1 === v2, 1: v1 > v2
 */
function compareVersion(v1: string, v2: string): number {
	const parts1 = v1.split('.').map(Number);
	const parts2 = v2.split('.').map(Number);

	for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
		const p1 = parts1[i] || 0;
		const p2 = parts2[i] || 0;
		if (p1 < p2) return -1;
		if (p1 > p2) return 1;
	}

	return 0;
}

/**
 * 检查配置完整性
 */
export function checkConfigIntegrity(config: BladeConfig): {
	valid: boolean;
	warnings: string[];
	errors: string[];
} {
	const warnings: string[] = [];
	const errors: string[] = [];

	// 检查模型配置
	if (!config.models || config.models.length === 0) {
		errors.push('没有配置任何模型');
	} else {
		const currentModel = config.models.find((m) => m.id === config.currentModelId);
		if (!currentModel) {
			errors.push(`当前模型 ID "${config.currentModelId}" 不存在`);
		}
	}

	// 检查 API Key
	config.models?.forEach((model, index) => {
		if (!model.apiKey || model.apiKey.trim() === '') {
			warnings.push(`模型 ${index + 1} (${model.name}) 缺少 API Key`);
		}
	});

	// 检查 MCP 服务器配置
	if (config.mcpEnabled && Object.keys(config.mcpServers || {}).length === 0) {
		warnings.push('MCP 已启用但未配置任何服务器');
	}

	// 检查权限配置
	if (!config.permissions || !config.permissions.allow) {
		warnings.push('权限配置不完整');
	}

	return {
		valid: errors.length === 0,
		warnings,
		errors,
	};
}
