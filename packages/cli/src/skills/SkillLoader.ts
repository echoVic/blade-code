/**
 * SkillLoader - SKILL.md 文件解析器
 *
 * 负责解析 SKILL.md 文件的 YAML 前置数据和 Markdown 正文内容。
 * 支持 Progressive Disclosure：可以只加载元数据，或加载完整内容。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillContent, SkillMetadata, SkillParseResult } from './types.js';

/** YAML 前置数据的分隔符 */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Skill 名称验证：小写字母、数字、连字符，≤64字符 */
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

/** 描述最大长度 */
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * 解析 SKILL.md 的 YAML 前置数据
 * 完全对齐 Claude Code Skills 规范
 */
interface RawFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string | string[];
  version?: string;
  /** 参数提示，如 '<file_path>' */
  'argument-hint'?: string;
  /** 是否支持 /skill-name 调用 */
  'user-invocable'?: boolean | string;
  /** 是否禁止 AI 自动调用 */
  'disable-model-invocation'?: boolean | string;
  /** 指定模型 */
  model?: string;
  /** 额外触发条件 */
  when_to_use?: string;
}

/**
 * 验证并规范化 allowed-tools 字段
 */
function parseAllowedTools(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;

  if (typeof raw === 'string') {
    // 支持逗号分隔的字符串格式：'Read, Grep, Glob'
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }

  return undefined;
}

/**
 * 解析布尔值字段（支持 true/false 字符串）
 */
function parseBoolean(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === 'yes' || lower === '1') return true;
    if (lower === 'false' || lower === 'no' || lower === '0') return false;
  }
  return undefined;
}

/**
 * 验证 Skill 元数据
 */
function validateMetadata(
  frontmatter: RawFrontmatter,
  filePath: string
):
  | { valid: true; metadata: Omit<SkillMetadata, 'path' | 'basePath' | 'source'> }
  | { valid: false; error: string } {
  // 验证 name
  if (!frontmatter.name) {
    return { valid: false, error: 'Missing required field: name' };
  }
  if (!NAME_REGEX.test(frontmatter.name)) {
    return {
      valid: false,
      error: `Invalid name "${frontmatter.name}": must be lowercase letters, numbers, and hyphens only, 1-64 characters`,
    };
  }

  // 验证 description
  if (!frontmatter.description) {
    return { valid: false, error: 'Missing required field: description' };
  }
  if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description too long: ${frontmatter.description.length} characters (max ${MAX_DESCRIPTION_LENGTH})`,
    };
  }

  // 解析 model 字段
  let model: string | undefined;
  if (frontmatter.model) {
    // 'inherit' 表示继承当前模型，其他值为具体模型名
    model = frontmatter.model === 'inherit' ? 'inherit' : frontmatter.model;
  }

  return {
    valid: true,
    metadata: {
      name: frontmatter.name,
      description: frontmatter.description.trim(),
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
      version: frontmatter.version,
      // 新增字段
      argumentHint: frontmatter['argument-hint']?.trim(),
      userInvocable: parseBoolean(frontmatter['user-invocable']),
      disableModelInvocation: parseBoolean(frontmatter['disable-model-invocation']),
      model,
      whenToUse: frontmatter.when_to_use?.trim(),
    },
  };
}

/**
 * 解析 SKILL.md 文件内容
 */
function parseSkillContent(
  content: string,
  filePath: string,
  source: 'user' | 'project' | 'builtin'
): SkillParseResult {
  // 匹配 YAML 前置数据
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      success: false,
      error: 'Invalid SKILL.md format: missing YAML frontmatter (must start with ---)',
    };
  }

  const [, yamlContent, markdownContent] = match;

  // 解析 YAML
  let frontmatter: RawFrontmatter;
  try {
    frontmatter = parseYaml(yamlContent) as RawFrontmatter;
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 验证元数据
  const validation = validateMetadata(frontmatter, filePath);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
    };
  }

  const basePath = path.dirname(filePath);

  return {
    success: true,
    content: {
      metadata: {
        ...validation.metadata,
        path: filePath,
        basePath,
        source,
      },
      instructions: markdownContent.trim(),
    },
  };
}

/**
 * 从文件加载 Skill（仅元数据）
 */
export async function loadSkillMetadata(
  filePath: string,
  source: 'user' | 'project' | 'builtin'
): Promise<SkillParseResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseSkillContent(content, filePath, source);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${filePath}`,
      };
    }
    return {
      success: false,
      error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 加载完整 Skill 内容
 */
export async function loadSkillContent(
  metadata: SkillMetadata
): Promise<SkillContent | null> {
  try {
    const content = await fs.readFile(metadata.path, 'utf-8');
    const result = parseSkillContent(content, metadata.path, metadata.source);
    return result.success ? result.content! : null;
  } catch {
    return null;
  }
}

/**
 * 检查目录中是否存在 SKILL.md
 */
export async function hasSkillFile(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}
