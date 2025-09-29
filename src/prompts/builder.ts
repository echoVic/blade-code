/**
 * 系统提示构建器
 * 提供便捷的 API 来构建和管理系统提示
 */

import path from 'path';
import { SystemPrompt, type SystemPromptOptions } from './SystemPrompt.js';
import type { SystemPromptConfig } from './default.js';

/**
 * 提示构建器选项
 */
export interface PromptBuilderOptions {
  workingDirectory?: string;
  config?: Partial<SystemPromptConfig>;
}

/**
 * 系统提示构建器
 */
export class PromptBuilder {
  private options: PromptBuilderOptions;

  constructor(options: PromptBuilderOptions = {}) {
    this.options = {
      workingDirectory: process.cwd(),
      ...options,
    };
  }

  /**
   * 构建系统提示
   */
  async build(cliPrompt?: string): Promise<SystemPrompt> {
    const systemPromptOptions: SystemPromptOptions = {
      cliPrompt,
      config: this.options.config,
    };

    // 设置项目配置路径
    if (this.options.workingDirectory) {
      systemPromptOptions.projectPath = this.options.workingDirectory;
    }

    return SystemPrompt.fromSources(systemPromptOptions);
  }

  /**
   * 快速构建系统提示字符串
   */
  async buildString(cliPrompt?: string): Promise<string> {
    const systemPrompt = await this.build(cliPrompt);
    return systemPrompt.build();
  }

  /**
   * 获取项目配置文件路径
   */
  getProjectConfigPath(): string {
    return path.join(this.options.workingDirectory || process.cwd(), 'BLADE.md');
  }

  /**
   * 检查是否存在项目配置
   */
  async hasProjectConfig(): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      await fs.access(this.getProjectConfigPath());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 创建示例 BLADE.md 文件
   */
  async createExampleConfig(): Promise<string> {
    const exampleContent = this.getExampleConfigContent();
    const filePath = this.getProjectConfigPath();

    const fs = await import('fs/promises');
    const dir = path.dirname(filePath);

    // 确保目录存在
    await fs.mkdir(dir, { recursive: true });

    // 写入示例配置
    await fs.writeFile(filePath, exampleContent, 'utf-8');

    return filePath;
  }

  /**
   * 获取示例配置内容
   */
  private getExampleConfigContent(): string {
    return `# Blade Code 项目配置

这个文件定义了 Blade Code 在当前项目中的行为和个性。

## 项目背景
请描述这个项目的主要目的、技术栈和特殊要求。

## AI 助手行为指导
- 专注于本项目的技术栈和架构
- 遵循项目的代码规范和最佳实践
- 提供符合项目上下文的建议

## 示例自定义提示
\`\`\`
你是这个 TypeScript 项目的专家助手。请特别关注：
1. 类型安全和 TypeScript 最佳实践
2. 模块化架构和代码组织
3. 测试覆盖率和代码质量
4. 性能优化和安全考虑

在回答时请考虑项目的现有架构和约定。
\`\`\`

## 使用方法
1. 编辑此文件来自定义 AI 助手的行为
2. 删除示例内容，添加你的项目特定指导
3. Blade Code 会自动加载这些配置

---
此文件由 \`blade /init\` 命令创建。
`;
  }
}

/**
 * 默认构建器实例
 */
export const defaultPromptBuilder = new PromptBuilder();