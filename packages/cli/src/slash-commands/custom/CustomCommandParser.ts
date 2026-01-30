/**
 * 自定义命令解析器
 *
 * 解析 .md 文件，提取 Frontmatter 配置和 Markdown 正文
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { CustomCommand, CustomCommandConfig } from './types.js';

export class CustomCommandParser {
  /**
   * 解析 .md 文件
   *
   * @param filePath - 文件完整路径
   * @param basePath - 命令目录根路径（用于提取命名空间）
   * @param source - 来源类型（user/project）
   * @param sourceDir - 目录类型（claude/blade）
   */
  parse(
    filePath: string,
    basePath: string,
    source: 'user' | 'project',
    sourceDir: 'claude' | 'blade'
  ): CustomCommand | null {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data, content: body } = matter(fileContent);

      // 从文件路径提取命令名和命名空间
      const { name, namespace } = this.extractNameAndNamespace(filePath, basePath);

      if (!name) {
        return null;
      }

      return {
        name,
        namespace,
        config: this.normalizeConfig(data),
        content: body.trim(),
        path: filePath,
        source,
        sourceDir,
      };
    } catch (error) {
      // 解析失败返回 null
      console.error(`Failed to parse command file: ${filePath}`, error);
      return null;
    }
  }

  /**
   * 标准化 Frontmatter 配置
   * 将 kebab-case 转换为 camelCase
   */
  private normalizeConfig(data: Record<string, unknown>): CustomCommandConfig {
    return {
      description: this.asString(data.description),
      allowedTools: this.parseAllowedTools(data['allowed-tools']),
      argumentHint: this.asString(data['argument-hint']),
      model: this.asString(data.model),
      disableModelInvocation: data['disable-model-invocation'] === true,
    };
  }

  /**
   * 安全转换为字符串
   */
  private asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  /**
   * 解析 allowed-tools 配置
   * 支持多种格式:
   * - 字符串: "Bash(git add:*), Read, Write"
   * - 数组: ["Bash(git add:*)", "Read", "Write"]
   */
  private parseAllowedTools(value: unknown): string[] | undefined {
    if (!value) return undefined;

    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return undefined;
  }

  /**
   * 从文件路径提取命令名和命名空间
   *
   * 示例:
   * - commands/commit.md → { name: 'commit', namespace: undefined }
   * - commands/frontend/component.md → { name: 'component', namespace: 'frontend' }
   * - commands/backend/api/handler.md → { name: 'handler', namespace: 'backend/api' }
   */
  private extractNameAndNamespace(
    filePath: string,
    basePath: string
  ): { name: string; namespace?: string } {
    // 获取相对路径
    const relativePath = path.relative(basePath, filePath);

    // 分解路径
    const parts = relativePath.split(path.sep);

    // 最后一部分是文件名
    const fileName = parts.pop();
    if (!fileName) {
      return { name: '' };
    }

    // 去掉 .md 扩展名
    const name = fileName.replace(/\.md$/i, '');

    // 剩余部分是命名空间（用 / 连接）
    const namespace = parts.length > 0 ? parts.join('/') : undefined;

    return { name, namespace };
  }

  /**
   * 验证命令配置
   */
  validateConfig(config: CustomCommandConfig): string[] {
    const errors: string[] = [];

    // 目前没有强制必填字段
    // description 是可选的，但 SlashCommand 工具需要它

    // 验证 model 格式（如果提供）
    if (config.model && !this.isValidModelId(config.model)) {
      errors.push(`Invalid model ID: ${config.model}`);
    }

    return errors;
  }

  /**
   * 简单的模型 ID 验证
   */
  private isValidModelId(model: string): boolean {
    // 基本格式验证：非空字符串
    return model.length > 0 && model.length < 200;
  }
}
