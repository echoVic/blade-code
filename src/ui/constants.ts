/**
 * UI 模块常量配置
 */

/**
 * 粘贴检测配置
 */
export const PASTE_CONFIG = {
  /** chunk 合并超时时间（毫秒） */
  TIMEOUT_MS: 100,
  /** 快速输入判定阈值（毫秒） */
  RAPID_INPUT_THRESHOLD_MS: 150,
  /** 大文本判定阈值（字符数） */
  LARGE_INPUT_THRESHOLD: 300,
  /** 中等文本多 chunk 判定阈值（字符数） */
  MEDIUM_SIZE_MULTI_CHUNK_THRESHOLD: 200,
} as const;

/**
 * 图片扩展名列表
 */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
]);
