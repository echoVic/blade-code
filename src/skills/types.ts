/**
 * Skills 系统类型定义
 *
 * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。
 * 基于文件系统的简单架构（SKILL.md + 可选脚本/模板）。
 */

/**
 * Skill 元数据（从 SKILL.md YAML 前置数据解析）
 * 用于 Progressive Disclosure - 仅加载元数据到系统提示，节省 token
 */
export interface SkillMetadata {
  /** 唯一标识，小写+数字+连字符，≤64字符 */
  name: string;

  /** 激活描述，≤1024字符，包含"什么"和"何时使用" */
  description: string;

  /** 工具访问限制，如 ['Read', 'Grep', 'Bash(git:*)'] */
  allowedTools?: string[];

  /** 版本号 */
  version?: string;

  /** SKILL.md 文件完整路径 */
  path: string;

  /** Skill 目录路径（用于引用 scripts/templates/references） */
  basePath: string;

  /** 来源：user（~/.blade/skills）或 project（.blade/skills） */
  source: 'user' | 'project';
}

/**
 * Skill 完整内容（懒加载）
 */
export interface SkillContent {
  /** 元数据 */
  metadata: SkillMetadata;

  /** SKILL.md 正文内容（去除 YAML 前置数据后的 Markdown） */
  instructions: string;
}

/**
 * Skill 执行上下文
 */
export interface SkillExecutionContext {
  /** Skill 名称 */
  skillName: string;

  /** 执行期间的工具限制 */
  allowedTools?: string[];

  /** Skill 目录路径（可引用脚本/模板） */
  basePath: string;
}

/**
 * SKILL.md 解析结果
 */
export interface SkillParseResult {
  /** 是否解析成功 */
  success: boolean;

  /** 解析后的内容 */
  content?: SkillContent;

  /** 错误信息 */
  error?: string;
}

/**
 * Skill 注册表配置
 */
export interface SkillRegistryConfig {
  /** 用户级 skills 目录，默认 ~/.blade/skills */
  userSkillsDir?: string;

  /** 项目级 skills 目录，默认 .blade/skills */
  projectSkillsDir?: string;

  /** 当前工作目录 */
  cwd?: string;
}

/**
 * Skill 发现结果
 */
export interface SkillDiscoveryResult {
  /** 发现的 skills 列表 */
  skills: SkillMetadata[];

  /** 发现过程中的错误（不阻止其他 skills 加载） */
  errors: Array<{
    path: string;
    error: string;
  }>;
}
