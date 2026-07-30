/**
 * AI Provider 注册表
 * 统一管理所有 AI Provider
 */

import type { AIProvider, SupportedProvider } from './types';

export class ProviderRegistry {
	private providers = new Map<string, AIProvider>();

	/**
	 * 注册 Provider
	 */
	register(provider: AIProvider): void {
		if (this.providers.has(provider.name)) {
			console.warn(`Provider ${provider.name} 已注册，将被覆盖`);
		}
		this.providers.set(provider.name, provider);
	}

	/**
	 * 批量注册 Providers
	 */
	registerAll(providers: AIProvider[]): void {
		for (const provider of providers) {
			this.register(provider);
		}
	}

	/**
	 * 获取 Provider
	 */
	get(name: string): AIProvider | undefined {
		return this.providers.get(name);
	}

	/**
	 * 检查 Provider 是否存在
	 */
	has(name: string): boolean {
		return this.providers.has(name);
	}

	/**
	 * 获取所有 Provider 列表
	 */
	list(): AIProvider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * 获取所有 Provider 名称
	 */
	getNames(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * 注销 Provider
	 */
	unregister(name: string): boolean {
		return this.providers.delete(name);
	}

	/**
	 * 清空所有 Providers
	 */
	clear(): void {
		this.providers.clear();
	}

	/**
	 * 获取支持特定功能的 Providers
	 */
	findByFeature(feature: string): AIProvider[] {
		return this.list().filter((provider) =>
			provider.features.includes(feature as any),
		);
	}

	/**
	 * 获取支持特定模型的 Provider
	 */
	findByModel(modelId: string): AIProvider | undefined {
		return this.list().find((provider) =>
			provider.models.some((model) => model.id === modelId),
		);
	}
}

// 全局单例
let globalRegistry: ProviderRegistry | null = null;

/**
 * 获取全局 Provider 注册表
 */
export function getGlobalRegistry(): ProviderRegistry {
	if (!globalRegistry) {
		globalRegistry = new ProviderRegistry();
	}
	return globalRegistry;
}

/**
 * 重置全局注册表
 */
export function resetGlobalRegistry(): void {
	globalRegistry = null;
}
