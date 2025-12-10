/**
 * 系统提示构建器 - 统一入口
 *
 * ## 构建顺序（固定）
 * 1. 默认提示（DEFAULT_SYSTEM_PROMPT）或 replaceDefault
 * 2. 项目配置（BLADE.md）- 始终加载，不受 replaceDefault 影响
 * 3. 追加内容（append）
 * 4. 模式特定提示（Plan 模式等）
 *
 * ## 规则
 * - replaceDefault 仅替换默认提示，不影响 BLADE.md 和 append
 * - Plan 模式使用独立的 system prompt，但仍遵循上述顺序
 * - 各部分用 `\n\n---\n\n` 分隔
 */

import { promises as fs } from 'fs';
import path from 'path';
import { PermissionMode } from '../config/types.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { DEFAULT_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from './default.js';

/**
 * 提示词构建选项
 */
export interface BuildSystemPromptOptions {
  /**
   * 项目路径，用于查找 BLADE.md
   */
  projectPath?: string;

  /**
   * 替换默认提示（仅替换 DEFAULT_SYSTEM_PROMPT，不影响 BLADE.md）
   */
  replaceDefault?: string;

  /**
   * 追加到提示词末尾
   */
  append?: string;

  /**
   * 权限模式（Plan 模式会使用独立的 system prompt）
   */
  mode?: PermissionMode;

  /**
   * 是否包含环境上下文（默认 true）
   */
  includeEnvironment?: boolean;
}

/**
 * 提示词构建结果
 */
export interface BuildSystemPromptResult {
  /**
   * 最终的系统提示词
   */
  prompt: string;

  /**
   * 各部分来源（用于调试）
   */
  sources: Array<{
    name: string;
    loaded: boolean;
    length?: number;
  }>;
}

/**
 * 构建系统提示词（统一入口）
 *
 * 构建顺序：环境上下文 → 默认/replaceDefault → BLADE.md → append → 模式特定
 *
 * @example
 * // 普通模式
 * const { prompt } = await buildSystemPrompt({ projectPath: process.cwd() });
 *
 * // Plan 模式
 * const { prompt } = await buildSystemPrompt({ mode: PermissionMode.PLAN });
 *
 * // 替换默认，保留 BLADE.md
 * const { prompt } = await buildSystemPrompt({
 *   replaceDefault: 'Custom prompt',
 *   projectPath: '/my/project'
 * });
 */
export async function buildSystemPrompt(
  options: BuildSystemPromptOptions = {}
): Promise<BuildSystemPromptResult> {
  const {
    projectPath,
    replaceDefault,
    append,
    mode,
    includeEnvironment = true,
  } = options;

  const parts: string[] = [];
  const sources: BuildSystemPromptResult['sources'] = [];

  // 1. 环境上下文（始终在最前面）
  if (includeEnvironment) {
    const envContext = getEnvironmentContext();
    if (envContext) {
      parts.push(envContext);
      sources.push({ name: 'environment', loaded: true, length: envContext.length });
    }
  }

  // 2. 默认提示或替换内容
  // Plan 模式使用独立的 system prompt
  const isPlanMode = mode === PermissionMode.PLAN;
  const basePrompt = isPlanMode
    ? PLAN_MODE_SYSTEM_PROMPT
    : (replaceDefault ?? DEFAULT_SYSTEM_PROMPT);

  parts.push(basePrompt);
  sources.push({
    name: isPlanMode ? 'plan_mode_prompt' : replaceDefault ? 'replace_default' : 'default',
    loaded: true,
    length: basePrompt.length,
  });

  // 3. 项目配置（BLADE.md）- 始终加载，不受 replaceDefault 影响
  if (projectPath) {
    const bladeContent = await loadBladeConfig(projectPath);
    if (bladeContent) {
      parts.push(bladeContent);
      sources.push({ name: 'blade_md', loaded: true, length: bladeContent.length });
    } else {
      sources.push({ name: 'blade_md', loaded: false });
    }
  }

  // 4. 追加内容
  if (append?.trim()) {
    parts.push(append.trim());
    sources.push({ name: 'append', loaded: true, length: append.trim().length });
  }

  // 组合各部分
  const prompt = parts.join('\n\n---\n\n');

  return { prompt, sources };
}

/**
 * 加载项目 BLADE.md 配置
 */
async function loadBladeConfig(projectPath: string): Promise<string | null> {
  const bladePath = path.join(projectPath, 'BLADE.md');
  try {
    const content = await fs.readFile(bladePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

