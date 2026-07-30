/**
 * AI Providers 测试
 */

import { describe, it, expect } from 'vitest';
import {
	AnthropicProvider,
	OpenAIProvider,
	GoogleProvider,
	DeepSeekProvider,
} from '../../../src/providers';

describe('AnthropicProvider', () => {
	const provider = new AnthropicProvider();

	it('应该有正确的名称', () => {
		expect(provider.name).toBe('anthropic');
	});

	it('应该有模型列表', () => {
		expect(provider.models.length).toBeGreaterThan(0);
		expect(provider.models[0]).toHaveProperty('id');
		expect(provider.models[0]).toHaveProperty('name');
		expect(provider.models[0]).toHaveProperty('contextWindow');
	});

	it('应该支持必要的功能', () => {
		expect(provider.features).toContain('chat');
		expect(provider.features).toContain('streaming');
	});

	it('应该验证配置', () => {
		const validConfig = { apiKey: 'test-key' };
		const invalidConfig = {};

		const validResult = provider.validateConfig(validConfig);
		const invalidResult = provider.validateConfig(invalidConfig);

		expect(validResult.valid).toBe(true);
		expect(invalidResult.valid).toBe(false);
		expect(invalidResult.errors).toContain('API Key 是必需的');
	});

	it('应该返回默认模型', () => {
		const defaultModel = provider.getDefaultModel();
		expect(defaultModel).toBe('claude-3-5-sonnet-20241022');
	});

	it('应该获取模型信息', () => {
		const modelInfo = provider.getModelInfo('claude-3-5-sonnet-20241022');
		expect(modelInfo).toBeDefined();
		expect(modelInfo?.id).toBe('claude-3-5-sonnet-20241022');
	});

	it('应该创建客户端', () => {
		const client = provider.createClient({ apiKey: 'test-key' });
		expect(client).toBeDefined();
	});
});

describe('OpenAIProvider', () => {
	const provider = new OpenAIProvider();

	it('应该有正确的名称', () => {
		expect(provider.name).toBe('openai');
	});

	it('应该有模型列表', () => {
		expect(provider.models.length).toBeGreaterThan(0);
		const gpt4o = provider.models.find((m) => m.id === 'gpt-4o');
		expect(gpt4o).toBeDefined();
	});

	it('应该支持 embeddings', () => {
		expect(provider.features).toContain('embeddings');
	});

	it('应该验证配置', () => {
		const validConfig = { apiKey: 'test-key' };
		const result = provider.validateConfig(validConfig);
		expect(result.valid).toBe(true);
	});

	it('应该返回默认模型', () => {
		const defaultModel = provider.getDefaultModel();
		expect(defaultModel).toBe('gpt-4o');
	});

	it('应该获取模型信息', () => {
		const modelInfo = provider.getModelInfo('gpt-4o');
		expect(modelInfo).toBeDefined();
		expect(modelInfo?.name).toBe('GPT-4o');
	});
});

describe('GoogleProvider', () => {
	const provider = new GoogleProvider();

	it('应该有正确的名称', () => {
		expect(provider.name).toBe('google');
	});

	it('应该有 Gemini 模型', () => {
		const gemini = provider.models.find((m) => m.id.includes('gemini'));
		expect(gemini).toBeDefined();
	});

	it('应该支持大上下文窗口', () => {
		const gemini15Pro = provider.models.find((m) => m.id === 'gemini-1.5-pro');
		expect(gemini15Pro?.contextWindow).toBeGreaterThanOrEqual(1000000);
	});

	it('应该验证配置', () => {
		const validConfig = { apiKey: 'test-key' };
		const result = provider.validateConfig(validConfig);
		expect(result.valid).toBe(true);
	});

	it('应该返回默认模型', () => {
		const defaultModel = provider.getDefaultModel();
		expect(defaultModel).toBe('gemini-2.0-flash-exp');
	});
});

describe('DeepSeekProvider', () => {
	const provider = new DeepSeekProvider();

	it('应该有正确的名称', () => {
		expect(provider.name).toBe('deepseek');
	});

	it('应该有 DeepSeek 模型', () => {
		const chat = provider.models.find((m) => m.id === 'deepseek-chat');
		const reasoner = provider.models.find((m) => m.id === 'deepseek-reasoner');

		expect(chat).toBeDefined();
		expect(reasoner).toBeDefined();
	});

	it('应该验证配置', () => {
		const validConfig = { apiKey: 'test-key' };
		const result = provider.validateConfig(validConfig);
		expect(result.valid).toBe(true);
	});

	it('应该返回默认模型', () => {
		const defaultModel = provider.getDefaultModel();
		expect(defaultModel).toBe('deepseek-chat');
	});

	it('应该获取模型信息', () => {
		const modelInfo = provider.getModelInfo('deepseek-reasoner');
		expect(modelInfo).toBeDefined();
		expect(modelInfo?.name).toBe('DeepSeek Reasoner');
	});
});

describe('Provider 共同特性', () => {
	const providers = [
		new AnthropicProvider(),
		new OpenAIProvider(),
		new GoogleProvider(),
		new DeepSeekProvider(),
	];

	it('所有 providers 都应该支持 chat', () => {
		for (const provider of providers) {
			expect(provider.features).toContain('chat');
		}
	});

	it('所有 providers 都应该支持 streaming', () => {
		for (const provider of providers) {
			expect(provider.features).toContain('streaming');
		}
	});

	it('所有 providers 都应该有至少一个模型', () => {
		for (const provider of providers) {
			expect(provider.models.length).toBeGreaterThan(0);
		}
	});

	it('所有 providers 都应该有定价信息', () => {
		for (const provider of providers) {
			for (const model of provider.models) {
				expect(model.pricing).toBeDefined();
				expect(model.pricing?.input).toBeGreaterThanOrEqual(0);
				expect(model.pricing?.output).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('所有 providers 都应该验证 API Key', () => {
		for (const provider of providers) {
			const result = provider.validateConfig({});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('API Key 是必需的');
		}
	});

	it('所有 providers 都应该创建客户端', () => {
		for (const provider of providers) {
			const client = provider.createClient({ apiKey: 'test-key' });
			expect(client).toBeDefined();
			expect(client.chat).toBeDefined();
			expect(client.stream).toBeDefined();
		}
	});
});
