/**
 * 系统提示管理类
 * 负责加载、合并和构建系统提示
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_SYSTEM_PROMPT, type SystemPromptConfig } from './default.js';

export interface SystemPromptSource {
  type: 'default' | 'file' | 'cli' | 'config';
  content: string;
  priority: number;
  source?: string;
}

export interface SystemPromptOptions {
  cliPrompt?: string;
  projectPath?: string;
  config?: Partial<SystemPromptConfig>;
}

/**
 * 系统提示管理类
 */
export class SystemPrompt {
  private sources: SystemPromptSource[] = [];
  private config: SystemPromptConfig;

  constructor(config?: Partial<SystemPromptConfig>) {
    this.config = {
      enabled: true,
      default: DEFAULT_SYSTEM_PROMPT,
      allowOverride: true,
      maxLength: 4000,
      ...config,
    };

    // 添加默认提示（最低优先级）
    this.addSource({
      type: 'default',
      content: this.config.default,
      priority: 0,
    });
  }

  /**
   * 添加提示源
   */
  addSource(source: SystemPromptSource): void {
    this.sources.push(source);
    // 按优先级排序
    this.sources.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 从文件加载提示
   */
  async loadFromFile(filePath: string, priority: number = 5): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim()) {
        this.addSource({
          type: 'file',
          content: content.trim(),
          priority,
          source: filePath,
        });
        return true;
      }
    } catch (_error) {
      // 文件不存在或无法读取，忽略
    }
    return false;
  }

  /**
   * 添加 CLI 提示
   */
  addCliPrompt(prompt: string): void {
    if (!this.config.allowOverride) {
      return;
    }

    this.addSource({
      type: 'cli',
      content: prompt,
      priority: 10, // 最高优先级
    });
  }

  /**
   * 构建最终的系统提示
   */
  build(): string {
    if (!this.config.enabled || this.sources.length === 0) {
      return '';
    }

    // 按优先级合并所有提示
    const parts: string[] = [];

    for (const source of this.sources) {
      if (source.content.trim()) {
        parts.push(source.content.trim());
      }
    }

    const finalPrompt = parts.join('\n\n---\n\n');

    // 检查长度限制
    if (finalPrompt.length > this.config.maxLength) {
      console.warn(
        `系统提示长度 (${finalPrompt.length}) 超过限制 (${this.config.maxLength})，可能影响性能`
      );
    }

    return finalPrompt;
  }

  /**
   * 获取提示源信息（用于调试）
   */
  getSources(): SystemPromptSource[] {
    return [...this.sources];
  }

  /**
   * 清除所有非默认源
   */
  clear(): void {
    this.sources = this.sources.filter((source) => source.type === 'default');
  }

  /**
   * 静态方法：从多个源创建系统提示
   */
  static async fromSources(options: SystemPromptOptions): Promise<SystemPrompt> {
    const prompt = new SystemPrompt(options.config);

    // 加载项目配置（优先级：5）
    if (options.projectPath) {
      // 查找项目目录下的 BLADE.md 文件
      const projectFile = path.join(options.projectPath, 'BLADE.md');
      await prompt.loadFromFile(projectFile, 5);
    }

    // 添加 CLI 提示（优先级：10）
    if (options.cliPrompt) {
      prompt.addCliPrompt(options.cliPrompt);
    }

    return prompt;
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
