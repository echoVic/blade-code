/**
 * Provider Registry 测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	ProviderRegistry,
	AnthropicProvider,
	OpenAIProvider,
	GoogleProvider,
	DeepSeekProvider,
	getGlobalRegistry,
	resetGlobalRegistry,
} from '../../../src/providers';

describe('ProviderRegistry', () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		registry = new ProviderRegistry();
	});

	describe('注册 Provider', () => {
		it('应该注册单个 provider', () => {
			const provider = new AnthropicProvider();
			registry.register(provider);

			expect(registry.has('anthropic')).toBe(true);
			expect(registry.get('anthropic')).toBe(provider);
		});

		it('应该批量注册 providers', () => {
			const providers = [
				new AnthropicProvider(),
				new OpenAIProvider(),
				new GoogleProvider(),
			];

			registry.registerAll(providers);

			expect(registry.has('anthropic')).toBe(true);
			expect(registry.has('openai')).toBe(true);
			expect(registry.has('google')).toBe(true);
		});

		it('应该覆盖已存在的 provider', () => {
			const provider1 = new AnthropicProvider();
			const provider2 = new AnthropicProvider();

			registry.register(provider1);
			registry.register(provider2);

			expect(registry.get('anthropic')).toBe(provider2);
		});
	});

	describe('查询 Provider', () => {
		beforeEach(() => {
			registry.registerAll([
				new AnthropicProvider(),
				new OpenAIProvider(),
				new GoogleProvider(),
				new DeepSeekProvider(),
			]);
		});

		it('应该获取 provider', () => {
			const provider = registry.get('anthropic');
			expect(provider).toBeDefined();
			expect(provider?.name).toBe('anthropic');
		});

		it('应该返回 undefined 对于不存在的 provider', () => {
			const provider = registry.get('nonexistent');
			expect(provider).toBeUndefined();
		});

		it('应该检查 provider 是否存在', () => {
			expect(registry.has('anthropic')).toBe(true);
			expect(registry.has('nonexistent')).toBe(false);
		});

		it('应该列出所有 providers', () => {
			const providers = registry.list();
			expect(providers).toHaveLength(4);
			expect(providers.map((p) => p.name)).toEqual([
				'anthropic',
				'openai',
				'google',
				'deepseek',
			]);
		});

		it('应该获取所有 provider 名称', () => {
			const names = registry.getNames();
			expect(names).toHaveLength(4);
			expect(names).toEqual(['anthropic', 'openai', 'google', 'deepseek']);
		});
	});

	describe('查找 Provider', () => {
		beforeEach(() => {
			registry.registerAll([
				new AnthropicProvider(),
				new OpenAIProvider(),
				new GoogleProvider(),
				new DeepSeekProvider(),
			]);
		});

		it('应该根据功能查找 providers', () => {
			const providers = registry.findByFeature('streaming');
			expect(providers.length).toBeGreaterThan(0);
			expect(providers.every((p) => p.features.includes('streaming'))).toBe(true);
		});

		it('应该根据功能查找支持 vision 的 providers', () => {
			const providers = registry.findByFeature('vision');
			expect(providers.length).toBeGreaterThan(0);
		});

		it('应该根据模型 ID 查找 provider', () => {
			const provider = registry.findByModel('claude-3-5-sonnet-20241022');
			expect(provider).toBeDefined();
			expect(provider?.name).toBe('anthropic');
		});

		it('应该返回 undefined 对于未知模型', () => {
			const provider = registry.findByModel('unknown-model');
			expect(provider).toBeUndefined();
		});
	});

	describe('删除 Provider', () => {
		it('应该注销 provider', () => {
			const provider = new AnthropicProvider();
			registry.register(provider);

			const result = registry.unregister('anthropic');
			expect(result).toBe(true);
			expect(registry.has('anthropic')).toBe(false);
		});

		it('应该返回 false 对于不存在的 provider', () => {
			const result = registry.unregister('nonexistent');
			expect(result).toBe(false);
		});

		it('应该清空所有 providers', () => {
			registry.registerAll([
				new AnthropicProvider(),
				new OpenAIProvider(),
			]);

			registry.clear();

			expect(registry.list()).toHaveLength(0);
			expect(registry.has('anthropic')).toBe(false);
			expect(registry.has('openai')).toBe(false);
		});
	});

	describe('全局实例', () => {
		it('应该返回全局注册表实例', () => {
			const registry1 = getGlobalRegistry();
			const registry2 = getGlobalRegistry();

			expect(registry1).toBe(registry2);
		});

		it('应该重置全局注册表', () => {
			const registry1 = getGlobalRegistry();
			resetGlobalRegistry();
			const registry2 = getGlobalRegistry();

			expect(registry1).not.toBe(registry2);
		});
	});
});
