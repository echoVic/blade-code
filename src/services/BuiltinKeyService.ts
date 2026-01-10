/**
 * 内置 API Key 服务
 *
 * 内置模型的 API Key 已直接配置在 builtinModels.ts 中
 * 此服务仅作为兼容层，直接返回传入的 API Key
 */

export async function resolveBuiltinApiKey(apiKey: string): Promise<string> {
  return apiKey;
}

export function clearBuiltinKeyCache(): void {
  // no-op
}
