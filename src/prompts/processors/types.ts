/**
 * @ 文件提及的类型定义
 */

/**
 * 行号范围
 */
export interface LineRange {
  start: number;
  end?: number;
}

/**
 * @ 提及解析结果
 */
export interface AtMention {
  /** 原始文本，如 '@"foo.ts"' 或 '@foo.ts#L10-20' */
  raw: string;
  /** 提取的文件路径 */
  path: string;
  /** 可选的行号范围 */
  lineRange?: LineRange;
  /** 在输入中的起始位置 */
  startIndex: number;
  /** 在输入中的结束位置 */
  endIndex: number;
  /** 是否为 glob 模式（包含 *, ?, [ 等通配符） */
  isGlob?: boolean;
}

/**
 * 附件类型
 */
export type AttachmentType = 'file' | 'directory' | 'error';

/**
 * 附件元数据
 */
export interface AttachmentMetadata {
  /** 文件大小（字节） */
  size?: number;
  /** 行数 */
  lines?: number;
  /** 是否被截断 */
  truncated?: boolean;
  /** 行号范围 */
  lineRange?: LineRange;
}

/**
 * 附件对象
 */
export interface Attachment {
  /** 附件类型 */
  type: AttachmentType;
  /** 相对路径 */
  path: string;
  /** 文件内容 */
  content: string;
  /** 元数据 */
  metadata?: AttachmentMetadata;
  /** 错误信息（type='error' 时使用） */
  error?: string;
}

/**
 * 附件收集器选项
 */
export interface CollectorOptions {
  /** 工作目录 */
  cwd: string;
  /** 最大文件大小（字节），默认 1MB */
  maxFileSize?: number;
  /** 最大行数，默认 2000 */
  maxLines?: number;
  /** 最大 Token 数，默认 32000 */
  maxTokens?: number;
}
