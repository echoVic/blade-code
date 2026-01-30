/**
 * 自定义命令执行器
 *
 * 处理命令内容中的动态元素:
 * 1. 参数插值 ($ARGUMENTS, $1, $2, ...)
 * 2. Bash 命令嵌入 (!`command`)
 * 3. 文件引用 (@path/to/file)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CustomCommand, CustomCommandExecutionContext } from './types.js';

export class CustomCommandExecutor {
  /**
   * 执行自定义命令
   *
   * 处理顺序:
   * 1. 参数插值
   * 2. Bash 命令嵌入执行
   * 3. 文件引用替换
   *
   * @returns 处理后的命令内容，用于发送给 AI
   */
  async execute(
    command: CustomCommand,
    context: CustomCommandExecutionContext
  ): Promise<string> {
    let content = command.content;

    // 检查中止信号
    if (context.signal?.aborted) {
      throw new Error('Command execution aborted');
    }

    // 1. 参数插值
    content = this.interpolateArgs(content, context.args);

    // 2. Bash 命令嵌入执行
    content = await this.executeBashEmbeds(content, context);

    // 3. 文件引用替换
    content = await this.resolveFileReferences(content, context.workspaceRoot);

    return content;
  }

  /**
   * 参数插值
   *
   * 支持的语法:
   * - $ARGUMENTS: 替换为所有参数（空格连接）
   * - $1, $2, ...: 替换为对应位置的参数
   *
   * 示例:
   * - 输入: "Hello $1, args: $ARGUMENTS"
   * - 参数: ["World", "foo", "bar"]
   * - 输出: "Hello World, args: World foo bar"
   */
  private interpolateArgs(content: string, args: string[]): string {
    // 替换 $ARGUMENTS（所有参数）
    content = content.replace(/\$ARGUMENTS/g, args.join(' '));

    // 替换 $1, $2, ... $9（单个参数）
    // 从大到小替换，避免 $1 匹配 $10 的一部分
    for (let i = 9; i >= 1; i--) {
      const placeholder = `$${i}`;
      const value = args[i - 1] ?? '';
      content = content.split(placeholder).join(value);
    }

    return content;
  }

  /**
   * 执行 Bash 命令嵌入
   *
   * 语法: !`command`
   *
   * 示例:
   * - 输入: "Current branch: !`git branch --show-current`"
   * - 输出: "Current branch: main"
   *
   * 注意:
   * - 命令在 workspaceRoot 目录下执行
   * - 超时时间 30 秒
   * - 执行失败时返回错误消息
   */
  private async executeBashEmbeds(
    content: string,
    context: CustomCommandExecutionContext
  ): Promise<string> {
    // 匹配 !`command` 模式
    const regex = /!`([^`]+)`/g;
    const matches: Array<{ match: string; command: string }> = [];

    // 使用 matchAll 替代 exec 循环
    for (const match of content.matchAll(regex)) {
      matches.push({
        match: match[0],
        command: match[1],
      });
    }

    // 依次执行并替换
    let result = content;
    for (const { match: matchStr, command } of matches) {
      // 检查中止信号
      if (context.signal?.aborted) {
        result = result.replace(matchStr, '[Execution aborted]');
        continue;
      }

      try {
        const output = execSync(command, {
          cwd: context.workspaceRoot,
          encoding: 'utf-8',
          timeout: 30000, // 30 秒超时
          maxBuffer: 1024 * 1024, // 1MB 输出限制
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        result = result.replace(matchStr, output);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = result.replace(
          matchStr,
          `[Error executing '${command}': ${errorMessage}]`
        );
      }
    }

    return result;
  }

  /**
   * 解析文件引用
   *
   * 语法: @path/to/file
   *
   * 示例:
   * - 输入: "Review @src/utils.ts for issues"
   * - 输出: "Review [文件内容] for issues"
   *
   * 注意:
   * - 路径相对于 workspaceRoot
   * - 文件不存在时保留原文
   * - 自动检测是否为有效文件路径（避免误匹配 @username）
   */
  private async resolveFileReferences(
    content: string,
    workspaceRoot: string
  ): Promise<string> {
    // 匹配 @path/to/file 模式
    // 需要包含路径分隔符或文件扩展名，避免匹配 @username
    const regex = /@([\w./-]+(?:\/[\w./-]+|\.[\w]+))/g;
    const matches: Array<{ match: string; relativePath: string }> = [];

    // 使用 matchAll 替代 exec 循环
    for (const match of content.matchAll(regex)) {
      matches.push({
        match: match[0],
        relativePath: match[1],
      });
    }

    // 依次读取并替换
    let result = content;
    for (const { match: matchStr, relativePath } of matches) {
      const absolutePath = path.resolve(workspaceRoot, relativePath);

      try {
        // 检查文件是否存在且为普通文件
        const stat = fs.statSync(absolutePath);
        if (stat.isFile()) {
          const fileContent = fs.readFileSync(absolutePath, 'utf-8');
          // 用代码块格式包裹文件内容
          const extension = path.extname(relativePath).slice(1) || 'text';
          const formattedContent = `\`\`\`${extension}\n${fileContent}\n\`\`\``;
          result = result.replace(matchStr, formattedContent);
        }
      } catch {
        // 文件不存在或读取失败，保留原文
      }
    }

    return result;
  }

  /**
   * 验证命令内容是否包含动态元素
   */
  hasDynamicContent(content: string): {
    hasArgs: boolean;
    hasBashEmbeds: boolean;
    hasFileRefs: boolean;
  } {
    return {
      hasArgs: /\$ARGUMENTS|\$\d/.test(content),
      hasBashEmbeds: /!`[^`]+`/.test(content),
      hasFileRefs: /@[\w./-]+(?:\/[\w./-]+|\.[\w]+)/.test(content),
    };
  }
}
