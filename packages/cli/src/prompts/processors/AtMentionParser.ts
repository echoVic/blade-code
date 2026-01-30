/**
 * @ 文件提及解析器
 *
 * 支持以下语法：
 * - @path/to/file.ts          (裸路径)
 * - @"path with spaces.ts"    (带引号路径)
 * - @file.ts#L10              (单行)
 * - @file.ts#L10-20           (行范围)
 */

import type { AtMention, LineRange } from './types.js';

export class AtMentionParser {
  /**
   * 匹配两种格式：@"quoted" 或 @bareword
   *
   * 正则说明：
   * - @"([^"]+)"  : 匹配 @"..." 引号格式
   * - @([^\s]+)   : 匹配 @ 后面的非空白字符
   */
  private static readonly PATTERN = /@"([^"]+)"|@([^\s]+)/g;

  /**
   * 行号范围模式：#L10 或 #L10-20
   */
  private static readonly LINE_RANGE_PATTERN = /#L(\d+)(?:-(\d+))?$/;

  /**
   * Glob 通配符模式：检测 *, ?, [ 等字符
   */
  private static readonly GLOB_PATTERN = /[*?[\]]/;

  /**
   * 从用户输入中提取所有 @ 提及
   *
   * @param input - 用户输入的消息
   * @returns @ 提及数组
   *
   * @example
   * ```typescript
   * const mentions = AtMentionParser.extract('Read @src/agent.ts#L100-150');
   * // => [{ raw: '@src/agent.ts#L100-150', path: 'src/agent.ts', lineRange: { start: 100, end: 150 }, ... }]
   * ```
   */
  static extract(input: string): AtMention[] {
    const mentions: AtMention[] = [];
    let match: RegExpExecArray | null;

    // 重置正则状态（避免多次调用时状态残留）
    this.PATTERN.lastIndex = 0;

    while ((match = this.PATTERN.exec(input)) !== null) {
      const raw = match[0];
      // match[1] 是引号内容，match[2] 是裸路径
      let path = match[1] || match[2];

      // 解析行号后缀
      const lineRange = this.parseLineRange(path);
      if (lineRange) {
        // 移除行号后缀，保留纯路径
        path = path.replace(this.LINE_RANGE_PATTERN, '');
      }

      // 检测是否为 glob 模式
      const isGlob = this.GLOB_PATTERN.test(path);

      mentions.push({
        raw,
        path: path.trim(),
        lineRange,
        startIndex: match.index,
        endIndex: match.index + raw.length,
        isGlob,
      });
    }

    return mentions;
  }

  /**
   * 解析行号范围：#L10 或 #L10-20
   *
   * @param path - 可能包含行号后缀的路径
   * @returns 行号范围对象，如果没有则返回 undefined
   *
   * @example
   * ```typescript
   * parseLineRange('file.ts#L10-20')  // => { start: 10, end: 20 }
   * parseLineRange('file.ts#L10')     // => { start: 10 }
   * parseLineRange('file.ts')         // => undefined
   * ```
   */
  private static parseLineRange(path: string): LineRange | undefined {
    const match = path.match(this.LINE_RANGE_PATTERN);
    if (!match) return undefined;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : undefined;

    return { start, end };
  }

  /**
   * 快速检查输入是否包含 @ 提及
   *
   * @param input - 用户输入
   * @returns 是否包含 @ 符号
   */
  static hasAtMentions(input: string): boolean {
    return input.includes('@');
  }

  /**
   * 验证路径格式是否有效
   *
   * @param path - 文件路径
   * @returns 是否有效
   */
  static isValidPath(path: string): boolean {
    // 空路径无效
    if (!path || path.trim().length === 0) {
      return false;
    }

    // 不允许包含特殊字符
    const invalidChars = ['<', '>', '|', '\0'];
    for (const char of invalidChars) {
      if (path.includes(char)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 移除消息中的所有 @ 提及（替换为空字符串）
   *
   * @param input - 原始消息
   * @returns 移除 @ 提及后的消息
   *
   * @example
   * ```typescript
   * removeAtMentions('Read @file.ts and analyze')
   * // => 'Read  and analyze'
   * ```
   */
  static removeAtMentions(input: string): string {
    this.PATTERN.lastIndex = 0;
    return input.replace(this.PATTERN, '');
  }
}
