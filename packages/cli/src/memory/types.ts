/**
 * Auto Memory 类型定义
 */

export interface AutoMemoryConfig {
  /** 是否启用 Auto Memory */
  enabled: boolean;
  /** MEMORY.md 加载行数限制 */
  maxIndexLines: number;
}

export const DEFAULT_AUTO_MEMORY_CONFIG: AutoMemoryConfig = {
  enabled: true,
  maxIndexLines: 200,
};

export interface MemoryTopicInfo {
  /** 文件名（不含 .md 后缀） */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间 */
  lastModified: Date;
}
