import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const _MAX_LINES_TO_READ = 10000;

interface AtPath {
  path: string;
  lineRange?: {
    start: number; // 起始行号（包含）
    end: number; // 结束行号（包含）
  };
}

export class At {
  private cwd: string;

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
  }

  /**
   * 从提示词中提取 @ 引用路径
   * 支持格式：
   * - @file.ts
   * - @file.ts:10
   * - @file.ts:10-20
   * - @dir/
   */
  extractAtPaths(prompt: string): AtPath[] {
    const paths: AtPath[] = [];

    // 匹配 @ 引用的正则表达式
    // 排除 email 地址（前面有字母数字字符的 @）
    const atRegex = /(?:^|[^a-zA-Z0-9])@([a-zA-Z0-9/_.-]+(?::(?:\d+(?:-\d+)?))?)/g;

    let match: RegExpExecArray | null;
    while ((match = atRegex.exec(prompt)) !== null) {
      const fullRef = match[1];
      const parts = fullRef.split(':');
      const filePath = parts[0];

      if (!filePath) continue;

      const atPath: AtPath = { path: filePath };

      // 解析行号范围
      if (parts[1]) {
        const lineRange = parts[1];
        if (lineRange.includes('-')) {
          const [start, end] = lineRange.split('-').map(Number);
          atPath.lineRange = { start, end };
        } else {
          const line = Number(lineRange);
          atPath.lineRange = { start: line, end: line };
        }
      }

      paths.push(atPath);
    }

    return paths;
  }

  /**
   * 获取文件或目录的内容
   */
  getContent(atReference: string): string {
    const paths = this.extractAtPaths(atReference);
    if (paths.length === 0) {
      throw new Error(`Invalid @ reference: ${atReference}`);
    }

    const atPath = paths[0];
    const fullPath = path.resolve(this.cwd, atPath.path);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Path not found: ${atPath.path}`);
    }

    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
      return this.readDirectory(fullPath);
    }

    if (stats.isFile()) {
      return this.readFile(fullPath, atPath.lineRange);
    }

    throw new Error(`Invalid path type: ${atPath.path}`);
  }

  /**
   * 读取文件内容（支持行号范围）
   */
  private readFile(
    filePath: string,
    lineRange?: { start: number; end: number }
  ): string {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${filePath} (${stats.size} bytes > ${MAX_FILE_SIZE} bytes)`
      );
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    if (!lineRange) {
      // 返回整个文件
      return this.formatFileContent(filePath, content);
    }

    // 提取指定行号范围
    const { start, end } = lineRange;
    const startIdx = Math.max(0, start - 1);
    const endIdx = Math.min(lines.length, end);
    const selectedLines = lines.slice(startIdx, endIdx);

    return this.formatFileContent(filePath, selectedLines.join('\n'), start, end);
  }

  /**
   * 读取目录中的所有文件
   */
  private readDirectory(dirPath: string): string {
    const files = this.getAllFilesInDirectory(dirPath);
    const contents: string[] = [];

    for (const file of files) {
      try {
        const relPath = path.relative(this.cwd, file);
        const content = fs.readFileSync(file, 'utf-8');
        contents.push(this.formatFileContent(relPath, content));
      } catch (_error) {
        // 跳过无法读取的文件
        continue;
      }
    }

    return contents.join('\n\n---\n\n');
  }

  /**
   * 递归获取目录中的所有文件
   */
  private getAllFilesInDirectory(dirPath: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // 跳过隐藏文件和常见的忽略目录
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...this.getAllFilesInDirectory(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * 格式化文件内容输出
   */
  private formatFileContent(
    filePath: string,
    content: string,
    startLine?: number,
    endLine?: number
  ): string {
    const header = startLine
      ? `File: ${filePath} (lines ${startLine}-${endLine})`
      : `File: ${filePath}`;

    return `\`\`\`${this.getFileExtension(filePath)}\n${header}\n${content}\n\`\`\``;
  }

  /**
   * 获取文件扩展名（用于语法高亮）
   */
  private getFileExtension(filePath: string): string {
    const ext = path.extname(filePath).slice(1);
    return ext || 'text';
  }

  /**
   * 替换提示词中的 @ 引用为实际内容
   */
  replaceAtReferences(prompt: string): string {
    const paths = this.extractAtPaths(prompt);
    if (paths.length === 0) {
      return prompt;
    }

    let result = prompt;

    // 从后往前替换，避免位置偏移
    const matches: Array<{ match: string; atPath: AtPath }> = [];
    const atRegex = /(?:^|[^a-zA-Z0-9])(@[a-zA-Z0-9/_.-]+(?::(?:\d+(?:-\d+)?))?)/g;

    let match: RegExpExecArray | null;
    while ((match = atRegex.exec(prompt)) !== null) {
      const fullMatch = match[1];
      const atPath = this.extractAtPaths(fullMatch)[0];
      if (atPath) {
        matches.push({ match: fullMatch, atPath });
      }
    }

    // 从后往前替换
    for (let i = matches.length - 1; i >= 0; i--) {
      const { match: matchStr, atPath: _atPath } = matches[i];
      try {
        const content = this.getContent(matchStr);
        result = result.replace(matchStr, `\n\n${content}\n\n`);
      } catch (error) {
        // 如果文件不存在，保留原始引用
        console.warn(`Failed to resolve @ reference: ${matchStr}`, error);
      }
    }

    return result;
  }
}
