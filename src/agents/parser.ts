/**
 * Blade Subagent System - Configuration Parser
 *
 * 解析 Markdown 格式的 Subagent 配置文件（YAML frontmatter + 系统提示词）
 */

import { JSON_SCHEMA, YAMLException, load as yamlLoad } from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubagentConfig, SubagentDefinition } from './types.js';
import { ConfigParseError } from './types.js';

/**
 * Subagent 配置解析器
 */
export class SubagentConfigParser {
  /**
   * 解析 Markdown 文件为 SubagentDefinition
   *
   * @param filePath 配置文件路径
   * @returns SubagentDefinition
   * @throws ConfigParseError 解析失败时抛出
   */
  parse(filePath: string): SubagentDefinition {
    // 读取文件内容
    if (!fs.existsSync(filePath)) {
      throw new ConfigParseError(`File not found: ${filePath}`, filePath);
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // 解析 frontmatter 和系统提示词
    const { frontmatter, systemPrompt } = this.parseFrontmatter(content, filePath);

    // 验证必需字段
    this.validateRequired(frontmatter, filePath);

    // 转换为 SubagentDefinition
    return this.toDefinition(frontmatter, systemPrompt, filePath);
  }

  /**
   * 解析 Frontmatter 和内容
   *
   * 支持格式:
   * ---
   * key: value
   * ---
   * Content here
   */
  private parseFrontmatter(
    content: string,
    filePath: string
  ): { frontmatter: SubagentConfig; systemPrompt: string } {
    const lines = content.split('\n');

    // 检查是否以 --- 开头
    if (lines[0]?.trim() !== '---') {
      throw new ConfigParseError('Invalid frontmatter: must start with ---', filePath);
    }

    // 找到第二个 ---
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        endIndex = i;
        break;
      }
    }

    if (endIndex === -1) {
      throw new ConfigParseError('Invalid frontmatter: missing closing ---', filePath);
    }

    // 解析 YAML
    const yamlContent = lines.slice(1, endIndex).join('\n');
    const frontmatter: SubagentConfig = this.parseYaml(yamlContent, filePath);

    // 提取系统提示词（frontmatter 之后的所有内容）
    const systemPrompt = lines
      .slice(endIndex + 1)
      .join('\n')
      .trim();

    return { frontmatter, systemPrompt };
  }

  /**
   * 使用 js-yaml 解析 YAML
   *
   * 支持完整的 YAML 语法，包括复杂的嵌套对象和数组
   */
  private parseYaml(yamlContent: string, filePath: string): SubagentConfig {
    try {
      const parsed = yamlLoad(yamlContent, {
        filename: filePath,
        // 安全模式，防止执行任意代码
        schema: JSON_SCHEMA,
      });

      if (!parsed || typeof parsed !== 'object') {
        throw new ConfigParseError('Invalid YAML: expected an object', filePath);
      }

      return parsed as SubagentConfig;
    } catch (error) {
      if (error instanceof ConfigParseError) {
        throw error;
      }

      const yamlError = error as YAMLException;
      throw new ConfigParseError(`YAML parsing error: ${yamlError.message}`, filePath);
    }
  }

  /**
   * 验证必需字段
   */
  private validateRequired(config: SubagentConfig, filePath: string): void {
    if (!config.name) {
      throw new ConfigParseError('Missing required field: name', filePath);
    }

    if (!config.description) {
      throw new ConfigParseError('Missing required field: description', filePath);
    }

    // 验证 name 格式（小写字母、数字、连字符）
    if (!/^[a-z0-9-]+$/.test(config.name)) {
      throw new ConfigParseError(
        `Invalid name format: ${config.name}. Must use lowercase letters, numbers, and hyphens only.`,
        filePath
      );
    }
  }

  /**
   * 转换为 SubagentDefinition
   */
  private toDefinition(
    config: SubagentConfig,
    systemPrompt: string,
    filePath: string
  ): SubagentDefinition {
    // 解析 tools 字符串为数组
    let tools: string[] | undefined;
    if (config.tools) {
      tools = config.tools
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }

    // 验证 model 值
    if (config.model && !['haiku', 'sonnet', 'opus'].includes(config.model)) {
      throw new ConfigParseError(
        `Invalid model: ${config.model}. Must be one of: haiku, sonnet, opus`,
        filePath
      );
    }

    return {
      name: config.name,
      displayName: config.displayName as string | undefined,
      description: config.description,
      systemPrompt,
      model: config.model,
      tools,
      maxTurns: config.max_turns,
      timeout: config.timeout,
      tokenBudget: config.token_budget || 100000, // 默认 100K tokens
      inputSchema: config.input_schema,
      outputSchema: config.output_schema,
      source: filePath,
    };
  }

  /**
   * 批量解析目录中的所有 .md 文件
   *
   * @param dirPath 目录路径
   * @returns SubagentDefinition 数组
   */
  parseDirectory(dirPath: string): SubagentDefinition[] {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const definitions: SubagentDefinition[] = [];
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(dirPath, file);

      try {
        const definition = this.parse(filePath);
        definitions.push(definition);
      } catch (error) {
        // 记录警告但继续处理其他文件
        console.warn(`Failed to parse ${file}:`, (error as Error).message);
      }
    }

    return definitions;
  }
}

/**
 * 创建默认解析器实例
 */
export function createParser(): SubagentConfigParser {
  return new SubagentConfigParser();
}
