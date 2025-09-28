import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { promises as fs } from 'fs';
import path from 'path';
import type { BladeConfig } from '../config/types.js';

export interface McpPrompt {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
  version: string;
  tags: string[];
  author?: string;
  template?: boolean;
}

export class McpPromptLoader {
  private config: BladeConfig;
  private mcpClient: Client | null = null;
  private localPrompts: Map<string, McpPrompt> = new Map();
  private remotePrompts: Map<string, McpPrompt> = new Map();

  constructor(config: BladeConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    // 初始化MCP客户端
    await this.initializeMcpClient();

    // 加载本地提示
    await this.loadLocalPrompts();

    // 加载远程提示
    await this.loadRemotePrompts();
  }

  private async initializeMcpClient(): Promise<void> {
    if (!this.config.mcp.enabled) {
      console.log('MCP未启用，跳过初始化');
      return;
    }

    try {
      // 这里应该初始化MCP客户端
      // 暂时留空，后续实现
      console.log('初始化MCP客户端');
    } catch (error) {
      console.error('MCP客户端初始化失败:', error);
    }
  }

  private async loadLocalPrompts(): Promise<void> {
    const promptsDir = path.join(process.cwd(), 'prompts');

    try {
      // 检查目录是否存在
      await fs.access(promptsDir);
    } catch {
      // 目录不存在，创建它
      await fs.mkdir(promptsDir, { recursive: true });
      console.log(`创建提示目录: ${promptsDir}`);
      return;
    }

    try {
      const files = await fs.readdir(promptsDir);

      for (const file of files) {
        if (file.endsWith('.json') || file.endsWith('.prompt')) {
          const filePath = path.join(promptsDir, file);
          await this.loadPromptFromFile(filePath);
        }
      }

      console.log(`加载了 ${this.localPrompts.size} 个本地提示`);
    } catch (error) {
      console.error('加载本地提示失败:', error);
    }
  }

  private async loadPromptFromFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const promptData = JSON.parse(content);

      const prompt: McpPrompt = {
        id: promptData.id || path.basename(filePath, path.extname(filePath)),
        name: promptData.name || path.basename(filePath, path.extname(filePath)),
        description: promptData.description || '',
        category: promptData.category || 'general',
        content: promptData.content || content,
        variables: promptData.variables || [],
        createdAt: new Date(promptData.createdAt || Date.now()),
        updatedAt: new Date(promptData.updatedAt || Date.now()),
        version: promptData.version || '1.0.0',
        tags: promptData.tags || [],
        author: promptData.author,
        template: promptData.template || false,
      };

      this.localPrompts.set(prompt.id, prompt);
      console.log(`加载提示: ${prompt.name} (${filePath})`);
    } catch (error) {
      console.error(`从文件加载提示失败: ${filePath}`, error);
    }
  }

  private async loadRemotePrompts(): Promise<void> {
    if (!this.config.mcp.enabled || !this.mcpClient) {
      console.log('MCP未启用，跳过远程提示加载');
      return;
    }

    try {
      // 这里应该从MCP服务器加载提示
      // 暂时留空，后续实现
      console.log('加载远程提示');
    } catch (error) {
      console.error('加载远程提示失败:', error);
    }
  }

  public async savePrompt(prompt: McpPrompt): Promise<void> {
    const promptsDir = path.join(process.cwd(), 'prompts');
    const fileName = `${prompt.id}.json`;
    const filePath = path.join(promptsDir, fileName);

    try {
      // 确保目录存在
      await fs.mkdir(promptsDir, { recursive: true });

      // 更新时间戳
      prompt.updatedAt = new Date();

      // 保存到文件
      const content = JSON.stringify(prompt, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');

      // 更新内存中的提示
      this.localPrompts.set(prompt.id, prompt);

      console.log(`保存提示: ${prompt.name} (${filePath})`);
    } catch (error) {
      console.error(`保存提示失败: ${filePath}`, error);
      throw error;
    }
  }

  public getPrompt(id: string): McpPrompt | undefined {
    // 首先查找本地提示
    let prompt = this.localPrompts.get(id);

    // 如果没找到，查找远程提示
    if (!prompt) {
      prompt = this.remotePrompts.get(id);
    }

    return prompt;
  }

  public getAllPrompts(): McpPrompt[] {
    const allPrompts: McpPrompt[] = [];

    // 添加本地提示
    for (const prompt of this.localPrompts.values()) {
      allPrompts.push(prompt);
    }

    // 添加远程提示
    for (const prompt of this.remotePrompts.values()) {
      // 避免重复
      if (!this.localPrompts.has(prompt.id)) {
        allPrompts.push(prompt);
      }
    }

    return allPrompts;
  }

  public getPromptsByCategory(category: string): McpPrompt[] {
    return this.getAllPrompts().filter(prompt => prompt.category === category);
  }

  public getPromptsByTag(tag: string): McpPrompt[] {
    return this.getAllPrompts().filter(prompt => prompt.tags.includes(tag));
  }

  public searchPrompts(query: string): McpPrompt[] {
    const lowerQuery = query.toLowerCase();

    return this.getAllPrompts().filter(prompt => {
      // 匹配ID
      if (prompt.id.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配名称
      if (prompt.name.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配描述
      if (prompt.description.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配内容
      if (prompt.content.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // 匹配标签
      if (prompt.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      // 匹配分类
      if (prompt.category.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      return false;
    });
  }

  public async deletePrompt(id: string): Promise<void> {
    const prompt = this.localPrompts.get(id);

    if (!prompt) {
      throw new Error(`提示 "${id}" 未找到`);
    }

    const promptsDir = path.join(process.cwd(), 'prompts');
    const fileName = `${prompt.id}.json`;
    const filePath = path.join(promptsDir, fileName);

    try {
      // 从文件系统删除
      await fs.unlink(filePath);

      // 从内存中删除
      this.localPrompts.delete(id);

      console.log(`删除提示: ${prompt.name} (${filePath})`);
    } catch (error) {
      console.error(`删除提示失败: ${filePath}`, error);
      throw error;
    }
  }

  public async exportPrompts(filePath: string): Promise<void> {
    try {
      const prompts = this.getAllPrompts();
      const content = JSON.stringify(prompts, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`导出 ${prompts.length} 个提示到: ${filePath}`);
    } catch (error) {
      console.error(`导出提示失败: ${filePath}`, error);
      throw error;
    }
  }

  public async importPrompts(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const prompts: McpPrompt[] = JSON.parse(content);

      for (const prompt of prompts) {
        await this.savePrompt(prompt);
      }

      console.log(`导入 ${prompts.length} 个提示从: ${filePath}`);
    } catch (error) {
      console.error(`导入提示失败: ${filePath}`, error);
      throw error;
    }
  }

  public async syncWithRemote(): Promise<void> {
    if (!this.config.mcp.enabled || !this.mcpClient) {
      console.log('MCP未启用，跳过同步');
      return;
    }

    try {
      // 这里应该实现与MCP服务器的同步逻辑
      // 暂时留空，后续实现
      console.log('与远程服务器同步提示');
    } catch (error) {
      console.error('同步提示失败:', error);
    }
  }

  public getPromptStats(): {
    total: number;
    local: number;
    remote: number;
    categories: Record<string, number>;
    tags: Record<string, number>;
  } {
    const allPrompts = this.getAllPrompts();
    const categories: Record<string, number> = {};
    const tags: Record<string, number> = {};

    // 统计分类
    for (const prompt of allPrompts) {
      categories[prompt.category] = (categories[prompt.category] || 0) + 1;

      // 统计标签
      for (const tag of prompt.tags) {
        tags[tag] = (tags[tag] || 0) + 1;
      }
    }

    return {
      total: allPrompts.length,
      local: this.localPrompts.size,
      remote: this.remotePrompts.size,
      categories,
      tags,
    };
  }
}
