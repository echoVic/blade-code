/**
 * 系统提示构建器 - 统一入口
 *
 * ## 构建顺序（固定）
 * 1. 默认提示（buildDefaultPrompt() 模块化组装）或 replaceDefault
 * 2. 项目指令（CLAUDE.md / AGENTS.md / BLADE.md）- 始终加载，不受 replaceDefault 影响
 * 3. Auto Memory（MEMORY.md 前 200 行）- 跨会话持久记忆
 * 4. 环境上下文（getEnvironmentContext）
 * 5. 追加内容（append）
 * 6. 模式特定提示（Plan 模式等）
 *
 * 默认提示由 sections.ts 的 8 个模块化段函数组装
 *
 * ## 规则
 * - replaceDefault 仅替换默认提示，不影响项目指令和 append
 * - Plan 模式使用独立的 system prompt，但仍遵循上述顺序
 * - 各部分用 `\n\n---\n\n` 分隔
 */

import { PermissionMode } from '../config/types.js';
import { AutoMemoryManager } from '../memory/AutoMemoryManager.js';
import { getSkillRegistry } from '../skills/index.js';
import {
  type EnvironmentContextOptions,
  getEnvironmentContext,
} from '../utils/environment.js';
import { DEFAULT_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from './default.js';
import { loadProjectInstructions } from './projectInstructions.js';

/** available_skills 占位符的正则表达式 */
const AVAILABLE_SKILLS_REGEX = /<available_skills>\s*<\/available_skills>/;

/**
 * 提示词构建选项
 */
export interface BuildSystemPromptOptions {
  /**
   * 项目路径，用于查找分层项目指令
   */
  projectPath?: string;

  /**
   * 替换默认提示（仅替换 DEFAULT_SYSTEM_PROMPT，不影响项目指令）
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

  /**
   * 环境上下文选项
   */
  environmentOptions?: EnvironmentContextOptions;

  /**
   * AI 回复语言（如 'zh-CN', 'en-US'）
   */
  language?: string;
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
 * 构建顺序：默认/replaceDefault -> 项目指令 -> Auto Memory -> 环境上下文 -> append -> 模式特定
 *
 * @example
 * // 普通模式
 * const { prompt } = await buildSystemPrompt({ projectPath: process.cwd() });
 *
 * // Plan 模式
 * const { prompt } = await buildSystemPrompt({ mode: PermissionMode.PLAN });
 *
 * // 替换默认，保留项目指令
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
    environmentOptions,
    language,
  } = options;

  const parts: string[] = [];
  const sources: BuildSystemPromptResult['sources'] = [];

  // 1. 默认提示或替换内容
  // Plan 模式使用独立的 system prompt
  const isPlanMode = mode === PermissionMode.PLAN;

  let basePrompt: string;
  let sourceName: string;

  if (isPlanMode) {
    basePrompt = PLAN_MODE_SYSTEM_PROMPT;
    sourceName = 'plan_mode_prompt';
  } else {
    basePrompt = replaceDefault ?? DEFAULT_SYSTEM_PROMPT;
    sourceName = replaceDefault ? 'replace_default' : 'default';
  }

  parts.push(basePrompt);
  sources.push({
    name: sourceName,
    loaded: true,
    length: basePrompt.length,
  });

  // 2. 分层项目指令 - 始终加载，不受 replaceDefault 影响
  if (projectPath) {
    const projectInstructions = await loadProjectInstructions(projectPath);
    if (projectInstructions) {
      parts.push(projectInstructions.content);
      sources.push({
        name: 'project_instructions',
        loaded: true,
        length: projectInstructions.content.length,
      });
    } else {
      sources.push({ name: 'project_instructions', loaded: false });
    }
  }

  // 3. Auto Memory（MEMORY.md 前 N 行）- 跨会话持久记忆
  if (projectPath && process.env.BLADE_AUTO_MEMORY !== '0') {
    try {
      const memoryManager = new AutoMemoryManager(projectPath);
      const memoryContent = await memoryManager.loadIndex();
      if (memoryContent) {
        parts.push(`<auto-memory>\n${memoryContent}\n</auto-memory>`);
        sources.push({
          name: 'auto_memory',
          loaded: true,
          length: memoryContent.length,
        });
      } else {
        sources.push({ name: 'auto_memory', loaded: false });
      }
    } catch {
      sources.push({ name: 'auto_memory', loaded: false });
    }
  }

  // 4. 环境上下文
  if (includeEnvironment) {
    const envContext = getEnvironmentContext(
      projectPath
        ? { ...environmentOptions, workingDirectory: projectPath }
        : environmentOptions
    );
    if (envContext) {
      parts.push(envContext);
      sources.push({ name: 'environment', loaded: true, length: envContext.length });
    }
  }

  // 5. 追加内容
  if (append?.trim()) {
    parts.push(append.trim());
    sources.push({ name: 'append', loaded: true, length: append.trim().length });
  }

  // 组合各部分
  let prompt = parts.join('\n\n---\n\n');

  // 注入 Skills 元数据到 <available_skills> 占位符
  prompt = injectSkillsToPrompt(prompt, projectPath);

  // 注入语言指令
  prompt = injectLanguageInstruction(prompt, language);

  return { prompt, sources };
}

/**
 * 注入 Skills 列表到系统提示的 <available_skills> 占位符
 */
function injectSkillsToPrompt(prompt: string, projectPath?: string): string {
  const registry = getSkillRegistry(projectPath ? { cwd: projectPath } : undefined);
  const skillsList = registry.generateAvailableSkillsList();

  // 如果没有 skills，保持占位符为空（但保留标签结构）
  if (!skillsList) {
    return prompt;
  }

  // 替换占位符
  return prompt.replace(
    AVAILABLE_SKILLS_REGEX,
    `<available_skills>\n${skillsList}\n</available_skills>`
  );
}

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Chinese (Simplified Chinese)',
  'zh-TW': 'Chinese (Traditional Chinese)',
  'en-US': 'English',
  'en-GB': 'English (British)',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'pt-BR': 'Portuguese (Brazilian)',
  'ru-RU': 'Russian',
};

function injectLanguageInstruction(prompt: string, language?: string): string {
  const lang = language || 'zh-CN';
  const langName = LANGUAGE_NAMES[lang] || lang;

  const instruction = `IMPORTANT: Always respond in ${langName}. All your responses must be in ${langName}.`;

  return prompt.replace('{{LANGUAGE_INSTRUCTION}}', instruction);
}
