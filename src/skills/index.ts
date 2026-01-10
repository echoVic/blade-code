/**
 * Skills 系统
 *
 * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。
 *
 * 核心特性：
 * - Progressive Disclosure：启动时仅加载元数据，执行时才加载完整内容
 * - 基于文件系统：SKILL.md + 可选脚本/模板
 * - AI 自动决策：LLM 根据 description 判断何时调用
 *
 * 目录结构：
 * - ~/.blade/skills/ - 用户级 skills（全局）
 * - .blade/skills/ - 项目级 skills（优先级更高）
 *
 * SKILL.md 格式：
 * ```yaml
 * ---
 * name: skill-name
 * description: 描述该 Skill 的功能和使用场景
 * allowed-tools: Read, Grep, Glob  # 可选
 * version: 1.0.0                    # 可选
 * ---
 *
 * ## Skill 指令内容
 *
 * 这里是完整的 Skill 执行指令...
 * ```
 */

export { injectSkillsMetadata } from './injectSkillsMetadata.js';
export { discoverSkills, getSkillRegistry } from './SkillRegistry.js';
