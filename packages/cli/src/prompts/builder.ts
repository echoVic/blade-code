/**
 * 系统提示构建器 - 统一入口
 *
 * ## 构建顺序（固定）
 * 1. 默认提示（buildDefaultPrompt() 模块化组装）或 replaceDefault
 * 2. Session communication style
 * 3. 项目指令（CLAUDE.md / AGENTS.md / BLADE.md）- 始终加载，不受 replaceDefault 影响
 * 4. Auto Memory（MEMORY.md 前 200 行）- 跨会话持久记忆
 * 5. 环境上下文（getEnvironmentContext）
 * 6. 追加内容（append）
 * 7. 模式特定提示（Plan 模式等）
 *
 * 默认提示由 sections.ts 的 8 个模块化段函数组装
 *
 * ## 规则
 * - replaceDefault 仅替换默认提示，不影响项目指令和 append
 * - Plan 模式使用独立的 system prompt，但仍遵循上述顺序
 * - 各部分用 `\n\n---\n\n` 分隔
 */

import type { ProjectRuleCatalog } from '../agent/resources/WorkspaceProjectRules.js';
import type { CommunicationStyleSelection } from '../config/types.js';
import { PermissionMode } from '../config/types.js';
import { AutoMemoryManager } from '../memory/AutoMemoryManager.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import {
  type CommunicationStyleCatalog,
  renderCommunicationStyleSection,
} from '../services/communicationStyle.js';
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
  /** Host workspace resources available to this prompt build. */
  workspaceAccess?: 'full' | 'none';
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

  /**
   * Optional resolved folder-trust decision. Callers normally omit this and
   * let the builder query WorkspaceTrustService.
   */
  projectTrusted?: boolean;

  /**
   * Immutable project-rule catalog owned by the current Session.
   */
  projectRuleCatalog?: ProjectRuleCatalog;

  /**
   * Source checkout path represented by the execution workspace.
   */
  projectInstructionSourcePath?: string;

  /**
   * Session-owned skill listing. When provided, the prompt must not consult a
   * live workspace registry that may have changed after Session creation.
   */
  availableSkills?: string;

  /**
   * Session-owned communication style. This affects presentation only and is
   * intentionally independent from provider-native response verbosity.
   */
  communicationStyle?: CommunicationStyleSelection;

  /**
   * Immutable style catalog owned by the current Session.
   */
  communicationStyleCatalog?: CommunicationStyleCatalog;
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
    projectTrusted,
    projectRuleCatalog,
    projectInstructionSourcePath,
    availableSkills,
    communicationStyle = 'auto',
    communicationStyleCatalog,
    workspaceAccess = 'full',
  } = options;
  const workspaceProjectPath = workspaceAccess === 'full' ? projectPath : undefined;

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

  // 2. Session-owned communication style
  const communicationStyleSection = renderCommunicationStyleSection(
    communicationStyle,
    communicationStyleCatalog
  );
  if (communicationStyleSection) {
    parts.push(communicationStyleSection);
    sources.push({
      name: 'communication_style',
      loaded: true,
      length: communicationStyleSection.length,
    });
  } else {
    sources.push({ name: 'communication_style', loaded: false });
  }

  const allowProjectInstructions =
    workspaceProjectPath !== undefined &&
    (projectTrusted ??
      (await WorkspaceTrustService.getInstance().getStatus(workspaceProjectPath))
        .state === 'trusted');

  // 3. 分层项目指令 - 仅在 Folder Trust 通过后加载
  if (workspaceProjectPath && allowProjectInstructions) {
    const projectInstructions = projectRuleCatalog
      ? projectRuleCatalog.staticRules(
          projectInstructionSourcePath ?? workspaceProjectPath
        )
      : await loadProjectInstructions(workspaceProjectPath);
    if (projectInstructions && projectInstructions.files.length > 0) {
      parts.push(projectInstructions.content);
      sources.push({
        name: 'project_instructions',
        loaded: true,
        length: projectInstructions.content.length,
      });
    } else {
      sources.push({ name: 'project_instructions', loaded: false });
    }
  } else if (workspaceProjectPath) {
    sources.push({ name: 'project_instructions', loaded: false });
  }

  // 4. Auto Memory（MEMORY.md 前 N 行）- 跨会话持久记忆
  if (workspaceProjectPath && process.env.BLADE_AUTO_MEMORY !== '0') {
    try {
      const memoryManager = new AutoMemoryManager(workspaceProjectPath);
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

  // 5. 环境上下文
  if (includeEnvironment) {
    const envContext = getEnvironmentContext(
      workspaceProjectPath && !environmentOptions?.workingDirectory
        ? { ...environmentOptions, workingDirectory: workspaceProjectPath }
        : environmentOptions
    );
    if (envContext) {
      parts.push(envContext);
      sources.push({ name: 'environment', loaded: true, length: envContext.length });
    }
  }

  // 6. 追加内容
  if (append?.trim()) {
    parts.push(append.trim());
    sources.push({ name: 'append', loaded: true, length: append.trim().length });
  }

  // 组合各部分
  let prompt = parts.join('\n\n---\n\n');

  // 注入 Skills 元数据到 <available_skills> 占位符
  prompt = injectSkillsToPrompt(
    prompt,
    workspaceProjectPath,
    workspaceAccess === 'none' ? (availableSkills ?? '') : availableSkills
  );

  // 注入语言指令
  prompt = injectLanguageInstruction(prompt, language);

  return { prompt, sources };
}

/**
 * 注入 Skills 列表到系统提示的 <available_skills> 占位符
 */
function injectSkillsToPrompt(
  prompt: string,
  projectPath?: string,
  availableSkills?: string
): string {
  const skillsList =
    availableSkills ??
    getSkillRegistry(
      projectPath ? { cwd: projectPath } : undefined
    ).generateAvailableSkillsList();

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
