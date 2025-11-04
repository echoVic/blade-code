# @ 文件上下文功能实现方案

> **作者**: AI Assistant
> **创建日期**: 2025-11-03
> **状态**: 实施中
> **参考**: Claude Code 源码分析、gemini-cli、neovate-code

## 目录

- [1. 概述](#1-概述)
- [2. 架构设计](#2-架构设计)
- [3. 语法规范](#3-语法规范)
- [4. 实现详解](#4-实现详解)
- [5. 安全控制](#5-安全控制)
- [6. 测试计划](#6-测试计划)
- [7. 实施路线图](#7-实施路线图)

---

## 1. 概述

### 1.1 功能描述

@ 文件上下文功能允许用户在对话中通过 `@` 语法引用项目文件，系统会自动读取文件内容并追加到用户消息中，作为 LLM 的上下文。

**用户体验示例：**
```
用户输入: "帮我分析 @src/agent/Agent.ts#L100-150 中的错误处理逻辑"
         ↓
系统处理: 读取 Agent.ts 的 100-150 行，追加到消息
         ↓
LLM 接收: 原始消息 + <system-reminder>包含的文件内容
```

### 1.2 设计目标

1. **易用性** - 简单直观的语法，支持自动补全
2. **安全性** - 严格的路径检查，防止越界访问
3. **性能** - 缓存机制，避免重复读取
4. **可扩展** - 预留接口支持未来扩展（MCP 资源等）

### 1.3 参考实现

本方案基于以下项目的实践：
- **Claude Code**: 生产级实现，两阶段架构（输入 + 发送）
- **gemini-cli**: 严格的解析器，支持嵌套大括号
- **neovate-code**: 简洁的语法，XML 格式化

---

## 2. 架构设计

### 2.1 两阶段处理架构

```
┌─────────────────────────────────────────────────────────┐
│ 阶段 1: 输入自动补全 (UI 层)                              │
│ ┌─────────┐    ┌─────────┐    ┌─────────┐              │
│ │检测 @ 触发│ → │搜索文件  │ → │显示建议  │ → 插入路径    │
│ └─────────┘    └─────────┘    └─────────┘              │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ 阶段 2: 发送前处理 (Agent 层)                             │
│ ┌─────────┐    ┌─────────┐    ┌─────────┐              │
│ │解析 @ 提及│ → │读取文件  │ → │转换附件  │ → 追加消息    │
│ └─────────┘    └─────────┘    └─────────┘              │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

#### 2.2.1 AtMentionParser（解析器）

**职责**: 从用户输入中提取 @ 提及

**输入**: 用户消息字符串
**输出**: AtMention[] 数组

```typescript
interface AtMention {
  raw: string;           // 原始文本 '@"foo.ts"' 或 '@foo.ts'
  path: string;          // 提取的路径 'foo.ts'
  lineRange?: {          // 可选的行号范围
    start: number;
    end?: number;
  };
  startIndex: number;    // 在输入中的起始位置
  endIndex: number;      // 在输入中的结束位置
}
```

#### 2.2.2 AttachmentCollector（收集器）

**职责**: 读取文件并转换为附件

**关键流程**:
1. 解析 @ 提及（调用 AtMentionParser）
2. 并行读取文件（Promise.all）
3. 安全检查（路径归一化、权限检查）
4. 格式化为 XML 上下文块
5. 追加到用户消息

#### 2.2.3 PathSecurity（安全检查）

**职责**: 路径安全验证

**检查项**:
- 工作区边界检查
- 路径遍历防护（`..`）
- 受限目录检测（`.git`, `.env` 等）
- 敏感文件检测（复用 SensitiveFileDetector）

#### 2.2.4 FileReadCache（缓存）

**职责**: 文件读取结果缓存

**特性**:
- 会话级缓存（避免重复读取）
- 时间戳过期策略（默认 60 秒）
- 自动清理机制

### 2.3 集成点

```typescript
// src/agent/Agent.ts

public async chat(
  message: string,
  context?: ChatContext,
  options?: LoopOptions
): Promise<string> {
  // ✨ 新增：在发送前处理 @ 提及
  const enhancedMessage = await this.processAtMentions(message);

  // 继续原有流程
  if (context) {
    const result = context.permissionMode === 'plan'
      ? await this.runPlanLoop(enhancedMessage, context, options)
      : await this.runLoop(enhancedMessage, context, options);
    // ...
  }
}

private async processAtMentions(message: string): Promise<string> {
  const attachments = await this.attachmentCollector.collect(message, {
    cwd: process.cwd(),
    maxFileSize: 1024 * 1024,  // 1MB
    maxTokens: 32000,          // 32k tokens
  });

  return this.appendAttachments(message, attachments);
}
```

---

## 3. 语法规范

### 3.1 基础语法

| 语法 | 说明 | 示例 |
|-----|-----|-----|
| `@path/to/file` | 裸路径（无空格） | `@src/agent.ts` |
| `@"path with spaces"` | 带引号路径（有空格） | `@"my file.ts"` |
| `@path#L10` | 单行引用 | `@agent.ts#L10` |
| `@path#L10-20` | 行范围引用 | `@agent.ts#L10-20` |
| `@directory/` | 目录引用（递归） | `@src/utils/` |

### 3.2 正则表达式

```typescript
// 匹配两种格式：@"quoted" 或 @bareword
const AT_MENTION_PATTERN = /@"([^"]+)"|\/@([^\s]+)/g;

// 行号后缀：#L10 或 #L10-20
const LINE_RANGE_PATTERN = /#L(\d+)(?:-(\d+))?$/;
```

### 3.3 解析示例

```typescript
输入: '分析 @src/agent.ts#L100-150 和 @"my file.ts" 的差异'

解析结果:
[
  {
    raw: '@src/agent.ts#L100-150',
    path: 'src/agent.ts',
    lineRange: { start: 100, end: 150 },
    startIndex: 3,
    endIndex: 28
  },
  {
    raw: '@"my file.ts"',
    path: 'my file.ts',
    lineRange: undefined,
    startIndex: 31,
    endIndex: 44
  }
]
```

---

## 4. 实现详解

### 4.1 AtMentionParser 实现

```typescript
// src/prompts/processors/AtMentionParser.ts

export class AtMentionParser {
  private static readonly PATTERN = /@"([^"]+)"|@([^\s]+)/g;
  private static readonly LINE_RANGE_PATTERN = /#L(\d+)(?:-(\d+))?$/;

  /**
   * 从用户输入中提取 @ 提及
   */
  static extract(input: string): AtMention[] {
    const mentions: AtMention[] = [];
    let match: RegExpExecArray | null;

    // 重置正则状态
    this.PATTERN.lastIndex = 0;

    while ((match = this.PATTERN.exec(input)) !== null) {
      const raw = match[0];
      let path = match[1] || match[2]; // 引号内容 或 裸路径

      // 解析行号后缀
      const lineRange = this.parseLineRange(path);
      if (lineRange) {
        // 移除行号后缀
        path = path.replace(this.LINE_RANGE_PATTERN, '');
      }

      mentions.push({
        raw,
        path: path.trim(),
        lineRange,
        startIndex: match.index,
        endIndex: match.index + raw.length,
      });
    }

    return mentions;
  }

  /**
   * 解析行号范围：#L10 或 #L10-20
   */
  private static parseLineRange(path: string): LineRange | undefined {
    const match = path.match(this.LINE_RANGE_PATTERN);
    if (!match) return undefined;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : undefined;

    return { start, end };
  }

  /**
   * 检查输入是否包含 @ 提及
   */
  static hasAtMentions(input: string): boolean {
    return input.includes('@');
  }
}
```

### 4.2 PathSecurity 实现

```typescript
// src/utils/pathSecurity.ts

import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * 受限路径列表（禁止访问）
 */
const RESTRICTED_PATHS = [
  '.git',
  '.claude',
  'node_modules',
  '.env',
  '.env.local',
  '.env.production',
];

/**
 * 路径安全检查工具
 */
export class PathSecurity {
  /**
   * 归一化路径（转为绝对路径）
   */
  static normalize(inputPath: string, workspaceRoot: string): string {
    // 转换为绝对路径
    const absolutePath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(workspaceRoot, inputPath);

    // 归一化（移除 .., . 等）
    const normalized = path.normalize(absolutePath);

    // 检查是否在工作区内
    if (!normalized.startsWith(workspaceRoot)) {
      throw new Error(
        `Path outside workspace: ${inputPath} (resolved to ${normalized})`
      );
    }

    return normalized;
  }

  /**
   * 检查受限路径
   */
  static checkRestricted(absolutePath: string): void {
    const segments = absolutePath.split(path.sep);

    for (const restricted of RESTRICTED_PATHS) {
      if (segments.includes(restricted)) {
        throw new Error(
          `Access denied: "${restricted}" is a protected directory`
        );
      }
    }
  }

  /**
   * 检查路径遍历
   */
  static checkTraversal(inputPath: string): void {
    if (inputPath.includes('..')) {
      throw new Error(`Path traversal not allowed: ${inputPath}`);
    }
  }

  /**
   * 完整安全检查
   */
  static async validatePath(
    inputPath: string,
    workspaceRoot: string
  ): Promise<string> {
    // 1. 路径遍历检查
    this.checkTraversal(inputPath);

    // 2. 归一化
    const absolutePath = this.normalize(inputPath, workspaceRoot);

    // 3. 受限路径检查
    this.checkRestricted(absolutePath);

    // 4. 检查文件/目录是否存在
    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`Path not found: ${inputPath}`);
    }

    return absolutePath;
  }
}
```

### 4.3 AttachmentCollector 实现

```typescript
// src/prompts/processors/AttachmentCollector.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { AtMentionParser, type AtMention } from './AtMentionParser.js';
import { PathSecurity } from '../../utils/pathSecurity.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.PROMPTS);

export interface Attachment {
  type: 'file' | 'directory' | 'error';
  path: string;
  content: string;
  metadata?: {
    size?: number;
    lines?: number;
    truncated?: boolean;
    lineRange?: { start: number; end?: number };
  };
  error?: string;
}

export interface CollectorOptions {
  cwd: string;
  maxFileSize?: number;  // 默认 1MB
  maxLines?: number;     // 默认 2000 行
  maxTokens?: number;    // 默认 32k tokens
}

export class AttachmentCollector {
  private fileCache = new Map<string, { content: string; timestamp: number }>();
  private options: Required<CollectorOptions>;

  constructor(options: CollectorOptions) {
    this.options = {
      maxFileSize: 1024 * 1024,  // 1MB
      maxLines: 2000,
      maxTokens: 32000,
      ...options,
    };
  }

  /**
   * 收集所有 @ 提及的附件
   */
  async collect(message: string): Promise<Attachment[]> {
    if (!AtMentionParser.hasAtMentions(message)) {
      return [];
    }

    const mentions = AtMentionParser.extract(message);
    if (mentions.length === 0) {
      return [];
    }

    logger.debug(`Found ${mentions.length} @ mentions`);

    // 并行处理（参考 Claude Code 的 Promise.all）
    const jobs = mentions.map(m => this.processOne(m));
    const results = await Promise.allSettled(jobs);

    // 转换为附件对象
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        // 错误情况：返回错误附件
        const mention = mentions[index];
        logger.warn(`Failed to process @${mention.path}:`, result.reason);
        return {
          type: 'error' as const,
          path: mention.path,
          content: '',
          error: result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        };
      }
    });
  }

  /**
   * 处理单个 @ 提及
   */
  private async processOne(mention: AtMention): Promise<Attachment> {
    // 安全验证
    const absolutePath = await PathSecurity.validatePath(
      mention.path,
      this.options.cwd
    );

    const stats = await fs.stat(absolutePath);

    // 目录处理
    if (stats.isDirectory()) {
      return await this.readDirectory(absolutePath, mention.path);
    }

    // 文件处理
    return await this.readFile(absolutePath, mention.path, mention.lineRange);
  }

  /**
   * 读取文件内容
   */
  private async readFile(
    absolutePath: string,
    relativePath: string,
    lineRange?: { start: number; end?: number }
  ): Promise<Attachment> {
    // 检查缓存
    const cached = this.fileCache.get(absolutePath);
    if (cached && Date.now() - cached.timestamp < 60000) {
      logger.debug(`Cache hit: ${relativePath}`);
      return this.formatFileAttachment(
        relativePath,
        cached.content,
        lineRange
      );
    }

    // 检查文件大小
    const stats = await fs.stat(absolutePath);
    if (stats.size > this.options.maxFileSize) {
      throw new Error(
        `File too large: ${Math.round(stats.size / 1024 / 1024)}MB ` +
        `(max ${Math.round(this.options.maxFileSize / 1024 / 1024)}MB)`
      );
    }

    // 读取文件
    const content = await fs.readFile(absolutePath, 'utf-8');

    // 缓存结果
    this.fileCache.set(absolutePath, {
      content,
      timestamp: Date.now(),
    });

    return this.formatFileAttachment(relativePath, content, lineRange);
  }

  /**
   * 格式化文件附件
   */
  private formatFileAttachment(
    relativePath: string,
    content: string,
    lineRange?: { start: number; end?: number }
  ): Attachment {
    const lines = content.split('\n');
    let finalContent = content;
    let truncated = false;

    // 行范围裁剪
    if (lineRange) {
      const start = Math.max(0, lineRange.start - 1); // 转为 0-based
      const end = lineRange.end ? lineRange.end : lineRange.start;
      finalContent = lines.slice(start, end).join('\n');
    } else {
      // 行数限制
      if (lines.length > this.options.maxLines) {
        finalContent = lines.slice(0, this.options.maxLines).join('\n');
        finalContent += `\n\n[... truncated ${lines.length - this.options.maxLines} lines ...]`;
        truncated = true;
      }
    }

    return {
      type: 'file',
      path: relativePath,
      content: finalContent,
      metadata: {
        lines: lines.length,
        truncated,
        lineRange,
      },
    };
  }

  /**
   * 读取目录内容
   */
  private async readDirectory(
    absolutePath: string,
    relativePath: string
  ): Promise<Attachment> {
    // 递归查找所有文件
    const files = await glob('**/*', {
      cwd: absolutePath,
      nodir: true,
      dot: false,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
    });

    if (files.length === 0) {
      return {
        type: 'directory',
        path: relativePath,
        content: '(empty directory)',
      };
    }

    // 限制文件数量
    const limitedFiles = files.slice(0, 50); // 最多 50 个文件

    // 读取所有文件
    const fileContents = await Promise.all(
      limitedFiles.map(async (file) => {
        const filePath = path.join(absolutePath, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          return `--- ${file} ---\n${content}\n`;
        } catch (error) {
          return `--- ${file} ---\n[Error reading file]\n`;
        }
      })
    );

    const content = fileContents.join('\n');
    const suffix = files.length > 50
      ? `\n\n[... ${files.length - 50} more files omitted ...]`
      : '';

    return {
      type: 'directory',
      path: relativePath,
      content: content + suffix,
      metadata: {
        lines: files.length,
      },
    };
  }

  /**
   * 清理过期缓存
   */
  clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.fileCache.entries()) {
      if (now - value.timestamp > 60000) {
        this.fileCache.delete(key);
      }
    }
  }
}
```

### 4.4 Agent 集成

```typescript
// src/agent/Agent.ts 修改

import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';

export class Agent extends EventEmitter {
  private attachmentCollector?: AttachmentCollector;

  async initialize(): Promise<void> {
    // ... 现有初始化代码 ...

    // 初始化附件收集器
    this.attachmentCollector = new AttachmentCollector({
      cwd: process.cwd(),
      maxFileSize: 1024 * 1024,  // 1MB
      maxLines: 2000,
      maxTokens: 32000,
    });

    logger.info('AttachmentCollector initialized');
  }

  public async chat(
    message: string,
    context?: ChatContext,
    options?: LoopOptions
  ): Promise<string> {
    // ✨ 新增：处理 @ 提及
    const enhancedMessage = await this.processAtMentions(message);

    // 继续原有流程
    if (context) {
      const result = context.permissionMode === 'plan'
        ? await this.runPlanLoop(enhancedMessage, context, options)
        : await this.runLoop(enhancedMessage, context, options);

      return result.output;
    }

    // ... 其他代码 ...
  }

  /**
   * 处理 @ 文件提及
   */
  private async processAtMentions(message: string): Promise<string> {
    if (!this.attachmentCollector) {
      return message;
    }

    try {
      const attachments = await this.attachmentCollector.collect(message);

      if (attachments.length === 0) {
        return message;
      }

      logger.debug(`Processed ${attachments.length} attachments`);

      return this.appendAttachments(message, attachments);
    } catch (error) {
      logger.error('Failed to process @ mentions:', error);
      return message; // 失败时返回原始消息
    }
  }

  /**
   * 将附件追加到消息
   */
  private appendAttachments(
    message: string,
    attachments: Attachment[]
  ): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}-${att.metadata.lineRange.end || att.metadata.lineRange.start})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let enhancedMessage = message;

    // 追加文件内容
    if (contextBlocks.length > 0) {
      enhancedMessage += '\n\n<system-reminder>\n';
      enhancedMessage += 'The following files were mentioned with @ syntax:\n\n';
      enhancedMessage += contextBlocks.join('\n');
      enhancedMessage += '\n</system-reminder>';
    }

    // 追加错误信息
    if (errors.length > 0) {
      enhancedMessage += '\n\n⚠️ Some files could not be loaded:\n';
      enhancedMessage += errors.join('\n');
    }

    return enhancedMessage;
  }
}
```

---

## 5. 安全控制

### 5.1 安全威胁模型

| 威胁 | 描述 | 缓解措施 |
|-----|-----|---------|
| **路径遍历** | 使用 `../../../etc/passwd` 访问工作区外文件 | 检测 `..` 并拒绝，归一化后验证边界 |
| **绝对路径越界** | 使用 `/etc/passwd` 直接访问系统文件 | 检查归一化后是否以 workspace root 开头 |
| **受限目录访问** | 访问 `.git`, `.env` 等敏感目录 | 黑名单检查，拒绝访问 |
| **符号链接** | 通过符号链接绕过边界检查 | `fs.realpath()` 解析真实路径后再检查 |
| **大文件攻击** | 引用超大文件耗尽内存 | 1MB 文件大小限制 |
| **目录递归** | 引用超大目录耗尽资源 | 限制 50 个文件，忽略 node_modules |

### 5.2 安全检查流程

```
用户输入: @../../../../etc/passwd
    ↓
步骤 1: checkTraversal()
    → 检测到 ".."，抛出错误 ❌

用户输入: @src/agent.ts
    ↓
步骤 2: normalize()
    → /workspace/src/agent.ts ✅
    ↓
步骤 3: checkRestricted()
    → 无受限路径 ✅
    ↓
步骤 4: fs.access()
    → 文件存在 ✅
    ↓
步骤 5: 读取文件内容
```

### 5.3 权限继承

@ 文件访问**不需要**额外的权限确认，因为：
1. 用户主动在消息中引用文件（明确意图）
2. 仍然受到工作区边界和受限路径的限制
3. 与现有 Read 工具的权限模型一致

---

## 6. 测试计划

### 6.1 单元测试

#### AtMentionParser 测试
```typescript
describe('AtMentionParser', () => {
  it('should extract bare path', () => {
    const mentions = AtMentionParser.extract('Read @src/agent.ts');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].path).toBe('src/agent.ts');
  });

  it('should extract quoted path with spaces', () => {
    const mentions = AtMentionParser.extract('Read @"my file.ts"');
    expect(mentions[0].path).toBe('my file.ts');
  });

  it('should parse line range', () => {
    const mentions = AtMentionParser.extract('@file.ts#L10-20');
    expect(mentions[0].lineRange).toEqual({ start: 10, end: 20 });
  });

  it('should handle multiple mentions', () => {
    const mentions = AtMentionParser.extract('@a.ts and @b.ts');
    expect(mentions).toHaveLength(2);
  });
});
```

#### PathSecurity 测试
```typescript
describe('PathSecurity', () => {
  const workspace = '/workspace';

  it('should reject path traversal', () => {
    expect(() => {
      PathSecurity.checkTraversal('../../etc/passwd');
    }).toThrow('Path traversal not allowed');
  });

  it('should reject paths outside workspace', () => {
    expect(() => {
      PathSecurity.normalize('/etc/passwd', workspace);
    }).toThrow('Path outside workspace');
  });

  it('should reject restricted directories', () => {
    expect(() => {
      PathSecurity.checkRestricted('/workspace/.git/config');
    }).toThrow('Access denied');
  });

  it('should normalize relative paths', () => {
    const result = PathSecurity.normalize('src/agent.ts', workspace);
    expect(result).toBe('/workspace/src/agent.ts');
  });
});
```

### 6.2 集成测试

```typescript
describe('AttachmentCollector', () => {
  let collector: AttachmentCollector;

  beforeEach(() => {
    collector = new AttachmentCollector({ cwd: '/workspace' });
  });

  it('should collect file attachment', async () => {
    const attachments = await collector.collect('Read @test.txt');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe('file');
  });

  it('should handle line range', async () => {
    const attachments = await collector.collect('@test.txt#L1-5');
    expect(attachments[0].content.split('\n')).toHaveLength(5);
  });

  it('should handle non-existent files gracefully', async () => {
    const attachments = await collector.collect('@missing.txt');
    expect(attachments[0].type).toBe('error');
    expect(attachments[0].error).toContain('not found');
  });

  it('should cache file reads', async () => {
    await collector.collect('@test.txt');
    const spy = jest.spyOn(fs, 'readFile');
    await collector.collect('@test.txt'); // 第二次应该命中缓存
    expect(spy).not.toHaveBeenCalled();
  });
});
```

### 6.3 E2E 测试

```typescript
describe('@ mentions E2E', () => {
  it('should enhance message with file content', async () => {
    const agent = new Agent(/* config */);
    await agent.initialize();

    const result = await agent.chat('Analyze @src/test.ts', context);

    // 验证文件内容被追加
    expect(result).toContain('<system-reminder>');
    expect(result).toContain('<file path="src/test.ts">');
  });

  it('should handle multiple files', async () => {
    const result = await agent.chat('@a.ts and @b.ts', context);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });
});
```

---

## 7. 实施路线图

### Phase 1: 核心功能（Week 1-2）

**目标**: 实现基础的 @ 文件引用功能

**任务**:
- [x] 创建 `AtMentionParser.ts`
- [x] 创建 `PathSecurity.ts`
- [x] 创建 `AttachmentCollector.ts`
- [x] 集成到 `Agent.ts`
- [ ] 编写单元测试
- [ ] 编写集成测试

**验收标准**:
- ✅ 支持 `@path` 和 `@"quoted path"` 语法
- ✅ 支持行号范围 `#L10-20`
- ✅ 安全检查通过所有测试
- ✅ 文件内容正确追加到消息

### Phase 2: 性能优化（Week 3）

**目标**: 提升性能和用户体验

**任务**:
- [ ] 实现 `FileReadCache`
- [ ] 实现 Token 估算和截断
- [ ] 优化并行处理
- [ ] 添加性能监控

**验收标准**:
- ✅ 缓存命中率 > 80%
- ✅ 处理时间 < 200ms (单文件)
- ✅ Token 限制生效

### Phase 3: UI 增强（Week 4）

**目标**: 添加自动补全提升体验

**任务**:
- [ ] 创建 `useAtCompletion.ts` hook
- [ ] 创建 `SuggestionDropdown.tsx` 组件
- [ ] 修改 `InputArea.tsx` 集成自动补全
- [ ] 添加键盘导航

**验收标准**:
- ✅ 输入 `@` 自动触发建议
- ✅ 模糊匹配工作正常
- ✅ Tab 键补全
- ✅ Esc 键关闭

### Phase 4: 高级特性（Future）

**目标**: 扩展功能支持更多场景

**可选任务**:
- [ ] 文件变化监听
- [ ] 目录智能过滤
- [ ] MCP 资源支持 `@server:uri`
- [ ] 代理提及支持 `@agent-*`
- [ ] 配置文件 `.bladeignore`

---

## 8. 附录

### 8.1 相关文件清单

**新增文件**:
```
src/prompts/processors/
├── AtMentionParser.ts          # @ 语法解析器
├── AttachmentCollector.ts      # 附件收集器
├── FileReadCache.ts            # 文件缓存（Phase 2）
└── types.ts                    # 类型定义

src/utils/
├── pathSecurity.ts             # 路径安全检查
└── tokenEstimator.ts           # Token 估算（Phase 2）

src/ui/hooks/
└── useAtCompletion.ts          # 自动补全 hook（Phase 3）

src/ui/components/
└── SuggestionDropdown.tsx      # 建议菜单（Phase 3）

tests/unit/prompts/
├── AtMentionParser.test.ts
├── AttachmentCollector.test.ts
└── PathSecurity.test.ts

tests/integration/
└── at-mentions.test.ts

tests/e2e/
└── at-mentions-e2e.test.ts
```

**修改文件**:
```
src/agent/Agent.ts              # 集成附件处理
src/ui/components/InputArea.tsx # 集成自动补全（Phase 3）
```

### 8.2 配置选项

未来可以在 `.blade/config.json` 中添加配置：

```json
{
  "atMentions": {
    "enabled": true,
    "maxFileSize": 1048576,      // 1MB
    "maxLines": 2000,
    "maxTokens": 32000,
    "cacheTimeout": 60000,       // 60 秒
    "ignorePatterns": [
      "node_modules/**",
      ".git/**",
      "dist/**"
    ]
  }
}
```

### 8.3 参考资源

- **Claude Code 源码分析** - cli.js:2861, cli.js:3441
- **gemini-cli** - `packages/cli/src/services/prompt-processors/`
- **neovate-code** - `src/at.ts`, `src/ui/useFileSuggestion.ts`
- **Blade 执行管道** - `docs/development/architecture/execution-pipeline.md`
- **Blade 工具系统** - `docs/development/architecture/tool-system.md`

---

**文档状态**: ✅ 设计完成，实施中
**最后更新**: 2025-11-03
**负责人**: Development Team
