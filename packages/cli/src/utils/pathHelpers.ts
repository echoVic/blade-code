/**
 * 跨平台路径工具函数
 *
 * 提供 Node.js path 模块未包含的辅助功能
 *
 * 注意：对于基本的路径操作（提取文件名、目录名等），
 * 请直接使用 Node.js 内置的 path 模块：
 *
 * ```typescript
 * import { basename, dirname, normalize } from 'node:path';
 *
 * const fileName = basename(filePath);  // 提取文件名
 * const dirName = dirname(filePath);    // 提取目录名
 * const normalized = normalize(filePath); // 规范化路径
 * ```
 */

/**
 * 检查路径是否以分隔符结尾（跨平台）
 *
 * @example
 * endsWithSeparator('/Users/john/') // true
 * endsWithSeparator('C:\\Users\\HP\\') // true
 * endsWithSeparator('/Users/john') // false
 */
export function endsWithSeparator(filePath: string): boolean {
  return filePath.endsWith('/') || filePath.endsWith('\\');
}

/**
 * 分割路径为各个部分（跨平台）
 *
 * @example
 * splitPath('/Users/john/file.txt') // ['Users', 'john', 'file.txt']
 * splitPath('C:\\Users\\HP\\file.txt') // ['C:', 'Users', 'HP', 'file.txt']
 */
export function splitPath(filePath: string): string[] {
  // 先规范化为正斜杠，再分割
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean);
}

