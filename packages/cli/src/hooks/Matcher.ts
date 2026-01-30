/**
 * Hook Matcher
 *
 * 负责匹配 Hook 触发条件
 *
 * 支持的匹配模式:
 * - 精确匹配: "Edit"
 * - 管道分隔: "Edit|Write|Delete"
 * - 正则表达式: ".*Tool$"
 * - 参数模式: "Bash(npm test*)" - 匹配工具名和参数
 * - 数组格式: ["Bash", "Read", "Write"] - 匹配任一工具
 */

import picomatch from 'picomatch';
import type { MatchContext, MatcherConfig } from './types/HookTypes.js';

/**
 * 参数模式正则
 * 匹配 "ToolName(pattern)" 或 "Tool1|Tool2(pattern)"
 */
const PARAM_PATTERN_REGEX = /^([A-Za-z0-9_|]+)\((.+)\)$/;

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

    // 工具名匹配 (支持参数模式和数组)
    if (config.tools && context.toolName) {
      if (!this.matchTools(config.tools, context)) {
        return false;
      }
    }

    // 文件路径匹配 (glob，支持数组)
    if (config.paths && context.filePath) {
      if (!this.matchPaths(config.paths, context.filePath)) {
        return false;
      }
    }

    // 命令匹配（支持数组）
    if (config.commands && context.command) {
      if (!this.matchCommands(config.commands, context.command)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 匹配工具名（支持字符串和数组）
   */
  private matchTools(tools: string | string[], context: MatchContext): boolean {
    // 数组格式：任一匹配即可
    if (Array.isArray(tools)) {
      return tools.some((pattern) => this.matchToolWithParams(pattern, context));
    }
    // 字符串格式
    return this.matchToolWithParams(tools, context);
  }

  /**
   * 匹配文件路径（支持字符串和数组）
   */
  private matchPaths(paths: string | string[], filePath: string): boolean {
    // 数组格式：任一匹配即可
    if (Array.isArray(paths)) {
      return paths.some((pattern) => {
        const isMatch = picomatch(pattern);
        return isMatch(filePath);
      });
    }
    // 字符串格式
    const isMatch = picomatch(paths);
    return isMatch(filePath);
  }

  /**
   * 匹配命令（支持字符串和数组）
   */
  private matchCommands(commands: string | string[], command: string): boolean {
    // 数组格式：任一匹配即可
    if (Array.isArray(commands)) {
      return commands.some((pattern) => this.matchPattern(command, pattern));
    }
    // 字符串格式
    return this.matchPattern(command, commands);
  }

  /**
   * 匹配工具名（支持参数模式）
   *
   * 示例:
   * - "Bash" - 匹配所有 Bash 调用
   * - "Bash(npm test*)" - 匹配命令以 "npm test" 开头的 Bash 调用
   * - "Read(*.ts)" - 匹配读取 .ts 文件的调用
   * - "Edit|Write(src/**)" - 匹配 Edit 或 Write 工具且路径在 src 目录下
   */
  private matchToolWithParams(pattern: string, context: MatchContext): boolean {
    const { toolName, command, filePath } = context;

    // 检查是否是参数模式
    const paramMatch = PARAM_PATTERN_REGEX.exec(pattern);

    if (!paramMatch) {
      // 普通模式，只匹配工具名
      return this.matchPattern(toolName!, pattern);
    }

    // 参数模式: Tool(argPattern)
    const [, toolPart, argPattern] = paramMatch;

    // 首先匹配工具名
    if (!this.matchPattern(toolName!, toolPart)) {
      return false;
    }

    // 然后匹配参数
    // 对于 Bash 工具，参数是 command
    // 对于 Read/Edit/Write 等工具，参数是 filePath
    const argValue = this.getArgValue(toolName!, command, filePath);

    if (!argValue) {
      // 没有参数值，无法匹配参数模式
      return false;
    }

    // 使用 glob 模式匹配参数
    return this.matchGlobOrPattern(argValue, argPattern);
  }

  /**
   * 获取工具的参数值
   */
  private getArgValue(
    toolName: string,
    command?: string,
    filePath?: string
  ): string | undefined {
    // Bash 工具使用 command
    if (toolName === 'Bash' || toolName === 'BashTool') {
      return command;
    }

    // 文件操作工具使用 filePath
    const fileTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
    if (fileTools.includes(toolName)) {
      return filePath;
    }

    // 其他工具尝试使用 command 或 filePath
    return command || filePath;
  }

  /**
   * 使用 glob 或简单模式匹配
   */
  private matchGlobOrPattern(value: string, pattern: string): boolean {
    // 如果包含 glob 特殊字符，使用 picomatch
    if (/[*?[\]{}!]/.test(pattern)) {
      try {
        const isMatch = picomatch(pattern, {
          bash: true,
          dot: true,
        });
        return isMatch(value);
      } catch {
        // glob 解析失败，fallback 到前缀匹配
      }
    }

    // 简单前缀匹配（如果 pattern 以 * 结尾）
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return value.startsWith(prefix);
    }

    // 精确匹配
    return value === pattern;
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
