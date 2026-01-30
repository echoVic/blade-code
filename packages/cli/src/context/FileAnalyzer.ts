/**
 * 文件分析服务
 * 用于从对话中提取重点文件并读取内容
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { Message } from '../services/ChatServiceInterface.js';

/**
 * 文件引用信息
 */
export interface FileReference {
  /** 文件路径 */
  path: string;
  /** 提及次数 */
  mentions: number;
  /** 最后提及的消息索引 */
  lastMentioned: number;
  /** 是否被修改过（通过 Write/Edit 工具） */
  wasModified: boolean;
}

/**
 * 文件内容
 */
export interface FileContent {
  /** 文件路径 */
  path: string;
  /** 文件内容 */
  content: string;
  /** 是否被截断 */
  truncated: boolean;
  /** 总行数 */
  lines: number;
  /** 实际包含的行数 */
  includedLines: number;
}

/**
 * File Analyzer - 分析对话中的文件引用
 */
export class FileAnalyzer {
  /** 最多包含的文件数量 */
  private static readonly MAX_FILES = 5;

  /** 单个文件最大行数 */
  private static readonly MAX_LINES_PER_FILE = 1000;

  /**
   * 分析消息中提到的文件
   *
   * @param messages - 消息列表
   * @returns 文件引用列表（按重要性排序，最多 5 个）
   */
  static analyzeFiles(messages: Message[]): FileReference[] {
    const fileMap = new Map<string, FileReference>();

    messages.forEach((msg, index) => {
      // 从消息内容中提取文件路径
      // 处理多模态消息：提取纯文本内容
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n');
      const contentFiles = this.extractFilePathsFromContent(textContent);
      contentFiles.forEach((path) => {
        this.updateFileReference(fileMap, path, index, false);
      });

      // 从工具调用中提取文件路径
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((call) => {
          const toolFiles = this.extractFilePathsFromToolCall(call);
          // 检查工具调用类型，确保有 function 属性
          const functionName =
            call.type === 'function' && 'function' in call ? call.function?.name : '';
          const wasModified = ['Write', 'Edit'].includes(functionName || '');

          toolFiles.forEach((path) => {
            this.updateFileReference(fileMap, path, index, wasModified);
          });
        });
      }
    });

    // 按重要性排序：1. 是否被修改 2. 提及次数 3. 最近度
    const sortedFiles = Array.from(fileMap.values()).sort((a, b) => {
      // 优先被修改的文件
      if (a.wasModified !== b.wasModified) {
        return a.wasModified ? -1 : 1;
      }

      // 其次按提及次数
      if (a.mentions !== b.mentions) {
        return b.mentions - a.mentions;
      }

      // 最后按最近度
      return b.lastMentioned - a.lastMentioned;
    });

    // 返回前 N 个文件
    return sortedFiles.slice(0, this.MAX_FILES);
  }

  /**
   * 读取文件内容
   *
   * @param filePaths - 文件路径列表
   * @returns 文件内容列表
   */
  static async readFilesContent(filePaths: string[]): Promise<FileContent[]> {
    const results: FileContent[] = [];

    for (const path of filePaths) {
      try {
        const content = await readFile(path, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        let finalContent = content;
        let truncated = false;
        let includedLines = totalLines;

        if (totalLines > this.MAX_LINES_PER_FILE) {
          // 截断文件
          finalContent = lines.slice(0, this.MAX_LINES_PER_FILE).join('\n');
          finalContent += `\n\n... (truncated ${totalLines - this.MAX_LINES_PER_FILE} lines)`;
          truncated = true;
          includedLines = this.MAX_LINES_PER_FILE;
        }

        results.push({
          path,
          content: finalContent,
          truncated,
          lines: totalLines,
          includedLines,
        });
      } catch (error) {
        // 文件读取失败，记录警告但不阻塞流程
        console.warn(`[FileAnalyzer] 无法读取文件: ${path}`, error);
      }
    }

    return results;
  }

  /**
   * 从消息内容中提取文件路径
   *
   * @param content - 消息内容
   * @returns 文件路径列表
   */
  private static extractFilePathsFromContent(content: string): string[] {
    const paths = new Set<string>();

    // 提取代码块中的文件路径
    const codeBlockRegex = /```(?:\w+)?\s*\n?([\s\S]*?)```/g;
    const matches = Array.from(content.matchAll(codeBlockRegex));

    for (const match of matches) {
      const block = match[1];
      // 查找类似 src/xxx/yyy.ts 的路径
      const pathMatches = this.extractPathsFromText(block);
      pathMatches.forEach((p) => paths.add(p));
    }

    // 提取普通文本中的文件路径
    const inlineMatches = this.extractPathsFromText(content);
    inlineMatches.forEach((p) => paths.add(p));

    return Array.from(paths);
  }

  /**
   * 从文本中提取文件路径
   *
   * @param text - 文本内容
   * @returns 文件路径列表
   */
  private static extractPathsFromText(text: string): string[] {
    const paths: string[] = [];

    // 匹配常见的项目文件路径模式
    const patterns = [
      // src/, tests/, docs/, lib/, config/ 等目录
      /(?:src|tests?|docs?|lib|config|scripts?|bin|utils?|components?|services?|hooks?)\/[\w\-/.]+\.[\w]+/g,
      // package.json, tsconfig.json 等配置文件
      /(?:package|tsconfig|vite\.config|webpack\.config|next\.config|babel\.config)\.[\w]+/g,
      // 绝对路径（以 / 或 ./ 或 ../ 开头）
      /(?:\.\.?\/|\/)[a-zA-Z0-9\-_/.]+\.[\w]+/g,
    ];

    for (const pattern of patterns) {
      const matches = Array.from(text.matchAll(pattern));
      for (const match of matches) {
        let path = match[0];

        // 清理路径
        path = path.replace(/[，。；：！？""''（）【】《》]$/g, ''); // 移除中文标点
        path = path.replace(/[,.;:!?"'()[\]<>]$/g, ''); // 移除英文标点

        // 验证路径（避免误匹配）
        if (this.isValidFilePath(path)) {
          paths.push(path);
        }
      }
    }

    return paths;
  }

  /**
   * 从工具调用中提取文件路径
   *
   * @param toolCall - 工具调用对象
   * @returns 文件路径列表
   */
  private static extractFilePathsFromToolCall(
    toolCall: ChatCompletionMessageToolCall
  ): string[] {
    const paths: string[] = [];

    if (toolCall.type !== 'function' || !toolCall.function) {
      return paths;
    }

    try {
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || '{}') as Record<
        string,
        unknown
      >;

      const fileTools = [
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'NotebookEdit',
        'mcp__github__get_file_contents',
        'mcp__github__create_or_update_file',
      ];

      if (fileTools.includes(functionName)) {
        const pathKeys = ['file_path', 'path', 'notebook_path', 'filePath'];
        for (const key of pathKeys) {
          if (args[key] && typeof args[key] === 'string') {
            paths.push(args[key]);
          }
        }
      }
    } catch {
      // 解析失败，忽略
    }

    return paths;
  }

  /**
   * 更新文件引用信息
   *
   * @param fileMap - 文件引用映射
   * @param path - 文件路径
   * @param index - 消息索引
   * @param wasModified - 是否被修改
   */
  private static updateFileReference(
    fileMap: Map<string, FileReference>,
    path: string,
    index: number,
    wasModified: boolean
  ): void {
    const existing = fileMap.get(path);

    if (existing) {
      existing.mentions++;
      existing.lastMentioned = index;
      existing.wasModified = existing.wasModified || wasModified;
    } else {
      fileMap.set(path, {
        path,
        mentions: 1,
        lastMentioned: index,
        wasModified,
      });
    }
  }

  /**
   * 验证文件路径是否有效
   *
   * @param path - 文件路径
   * @returns 是否有效
   */
  private static isValidFilePath(path: string): boolean {
    // 至少包含一个 /
    if (!path.includes('/')) {
      return false;
    }

    // 必须有文件扩展名
    const filename = basename(path);
    if (!filename.includes('.')) {
      return false;
    }

    // 常见的文件扩展名
    const validExtensions = [
      'ts',
      'tsx',
      'js',
      'jsx',
      'json',
      'md',
      'py',
      'java',
      'go',
      'rs',
      'c',
      'cpp',
      'h',
      'css',
      'scss',
      'html',
      'xml',
      'yaml',
      'yml',
      'toml',
      'sh',
      'bash',
      'sql',
      'graphql',
      'vue',
      'svelte',
    ];

    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext || !validExtensions.includes(ext)) {
      return false;
    }

    return true;
  }
}
