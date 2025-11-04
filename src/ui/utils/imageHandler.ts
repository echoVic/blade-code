/**
 * 图片处理工具
 *
 * 负责处理粘贴的图片，包括保存到临时目录、生成引用标签等
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';

/**
 * 图片处理结果
 */
export interface ImageHandleResult {
  /** 临时文件路径 */
  filePath: string;
  /** 文件名 */
  filename: string;
  /** 图片标签（用于插入到输入框） */
  tag: string;
}

/**
 * 保存 base64 图片到临时目录
 *
 * @param base64 - 图片的 base64 编码
 * @param mediaType - MIME 类型（如 image/png）
 * @param originalFilename - 原始文件名（可选）
 * @returns 图片处理结果
 */
export function saveImageToTemp(
  base64: string,
  mediaType: string,
  originalFilename?: string,
): ImageHandleResult {
  // 获取文件扩展名
  const extension = getExtensionFromMediaType(mediaType);

  // 生成唯一文件名
  const timestamp = Date.now();
  const uniqueId = nanoid(8);
  const filename = originalFilename || `blade_image_${timestamp}_${uniqueId}.${extension}`;

  // 临时目录路径
  const tempDir = tmpdir();
  const filePath = join(tempDir, filename);

  // 将 base64 转换为 Buffer 并保存
  const buffer = Buffer.from(base64, 'base64');
  writeFileSync(filePath, buffer);

  // 生成图片标签
  const tag = `[Image: ${filename}]`;

  console.log(`[ImageHandler] Saved image to: ${filePath}`);
  console.log(`[ImageHandler] Size: ${(buffer.length / 1024).toFixed(2)} KB`);

  return {
    filePath,
    filename,
    tag,
  };
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMediaType(mediaType: string): string {
  const typeMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };

  return typeMap[mediaType] || 'png';
}

/**
 * 清理临时图片文件
 *
 * @param filePath - 临时文件路径
 */
export function cleanupTempImage(filePath: string): void {
  try {
    const fs = require('node:fs');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[ImageHandler] Cleaned up temp image: ${filePath}`);
    }
  } catch (error) {
    console.error(`[ImageHandler] Failed to cleanup temp image: ${error}`);
  }
}
