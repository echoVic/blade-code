/**
 * 统一的错误分类与格式化模块
 *
 * 提供 `classifyError` 作为唯一的错误分类入口，
 * 统一处理 AbortError、嵌套 provider/API 错误、
 * 视觉模型不支持等所有错误类型，消除内层/外层 catch 的双轨分叉。
 */

/**
 * 错误分类结果
 */
export interface ExtractedError {
  /** 用户友好的错误消息 */
  displayMessage: string;
  /** 是否是 abort 导致的错误（AbortError 或 message 包含 'aborted'） */
  isAbort: boolean;
  /** 是否是视觉/多模态不支持错误 */
  isVisionNotSupported: boolean;
}

/**
 * 从 API 错误中提取用户友好的错误信息
 * 处理兼容层和 provider SDK 的嵌套错误结构
 */
function extractFriendlyErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';

  // 兼容历史错误结构：从嵌套的 lastError 中提取根因
  const retryError = error as Error & { lastError?: Error };
  const rootError = retryError.lastError ?? error;

  // APICallError: 尝试从 responseBody 解析原始错误消息
  const apiError = rootError as Error & {
    responseBody?: string;
    statusCode?: number;
  };

  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody);
      const msg = body?.error?.message;
      if (msg) {
        const statusHint = apiError.statusCode ? ` (HTTP ${apiError.statusCode})` : '';
        return `${msg}${statusHint}`;
      }
    } catch {
      // JSON 解析失败，fallback
    }
  }

  // 清理 RetryError 的冗长前缀
  const lastErrorMatch = error.message.match(/Last error:\s*(.+)$/);
  if (lastErrorMatch) {
    return lastErrorMatch[1];
  }

  return error.message;
}

/**
 * 检测是否为 AbortError
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.message.includes('aborted');
}

/**
 * 检测是否为视觉/多模态不支持的错误
 */
function isVisionNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes('can only concatenate str') ||
    msg.includes('image_url') ||
    msg.includes('multimodal') ||
    msg.includes('vision') ||
    msg.includes('does not support images')
  );
}

/**
 * 唯一的错误分类入口 — 两层 catch 都依赖此函数
 *
 * 内部包含：
 * 1. AbortError 检测（name === 'AbortError' || message.includes('aborted')）
 * 2. extractFriendlyErrorMessage（RetryError/APICallError 解包）
 * 3. vision 不支持检测（multimodal/image_url/vision 关键词）
 * 4. 最终 displayMessage 生成（vision 错误时替换为中文提示）
 */
export function classifyError(error: unknown): ExtractedError {
  const isAbort = isAbortError(error);
  const isVisionNotSupported = isVisionNotSupportedError(error);

  let displayMessage: string;
  if (isVisionNotSupported) {
    displayMessage =
      '当前模型不支持图片理解功能。请切换到支持视觉能力的模型（如 Claude 4.5、GPT-5.2、Gemini 3 Pro、Qwen3-VL-Plus 等）后重试。';
  } else {
    displayMessage = extractFriendlyErrorMessage(error);
  }

  return {
    displayMessage,
    isAbort,
    isVisionNotSupported,
  };
}
