/**
 * Hook Matcher
 *
 * 负责匹配 Hook 触发条件
 */

import picomatch from 'picomatch';
import type { MatchContext, MatcherConfig } from './types/HookTypes.js';

/**
 * Hook Matcher
 */
export class Matcher {
  /**
   * 检查是否匹配
   */
  matches(config: MatcherConfig | undefined, context: MatchContext): boolean {
    // 没有 matcher 配置,匹配所有
    if (!config) {
      return true;
    }

    // 工具名匹配
    if (config.tools && context.toolName) {
      if (!this.matchPattern(context.toolName, config.tools)) {
        return false;
      }
    }

    // 文件路径匹配 (glob)
    if (config.paths && context.filePath) {
      const isMatch = picomatch(config.paths);
      if (!isMatch(context.filePath)) {
        return false;
      }
    }

    // 命令匹配
    if (config.commands && context.command) {
      if (!this.matchPattern(context.command, config.commands)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 模式匹配
   *
   * 支持:
   * - 精确匹配: "Edit"
   * - 管道分隔: "Edit|Write|Delete"
   * - 正则表达式: ".*Tool$"
   */
  private matchPattern(value: string, pattern: string): boolean {
    // 通配符
    if (pattern === '*') {
      return true;
    }

    // 精确匹配
    if (!pattern.includes('|') && !/[.*+?^${}()|[\]\\]/.test(pattern)) {
      return value === pattern;
    }

    // 管道分隔
    if (pattern.includes('|')) {
      const parts = pattern.split('|').map((s) => s.trim());
      return parts.includes(value);
    }

    // 正则表达式
    try {
      const regex = new RegExp(pattern);
      return regex.test(value);
    } catch {
      // 无效正则,fallback 到精确匹配
      return value === pattern;
    }
  }
}
