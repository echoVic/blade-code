/**
 * 安全工具函数
 * 用于处理敏感信息的格式化和过滤
 */

/**
 * 格式化错误消息，移除敏感信息（如 API Key）
 *
 * @param error - 错误对象或字符串
 * @returns 移除敏感信息后的错误消息
 *
 * @example
 * ```typescript
 * try {
 *   await fetch('api', { headers: { 'Authorization': 'sk-abc123...' } });
 * } catch (error) {
 *   console.error(formatErrorMessage(error)); // API Key 被替换为 ***
 * }
 * ```
 */
export function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // 移除可能包含 API Key 的内容
  return message
    .replace(/sk-[a-zA-Z0-9]{32,}/g, 'sk-***') // OpenAI 格式的 key
    .replace(/apiKey['":\s]+[a-zA-Z0-9-_]+/gi, 'apiKey: ***') // JSON 中的 apiKey
    .replace(/API_KEY['":\s=]+[a-zA-Z0-9-_]+/gi, 'API_KEY=***'); // 环境变量格式
}
