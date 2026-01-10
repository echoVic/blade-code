import { z } from 'zod';
import { getSkillRegistry } from '../../../skills/index.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * Skill tool
 * Execute a skill within the main conversation
 *
 * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。
 * 执行 Skill 时，返回双消息：
 * - displayContent: 可见的加载提示（用户看到）
 * - llmContent: 完整的 Skill 指令（发送给 LLM）
 */
export const skillTool = createTool({
  name: 'Skill',
  displayName: 'Skill',
  kind: ToolKind.Execute,

  schema: z.object({
    skill: z
      .string()
      .describe('The skill name. E.g., "commit-message" or "code-review"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),

  description: {
    short: 'Execute a skill within the main conversation',
    long: `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

When using the Skill tool:
- Invoke skills using this tool with the skill name only
- When you invoke a skill, you will see <command-message>The "{name}" skill is loading</command-message>
- The skill's prompt will expand and provide detailed instructions on how to complete the task

Important:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>

</available_skills>
`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const { skill } = params;

    // 获取 SkillRegistry
    const registry = getSkillRegistry();

    // 检查 skill 是否存在
    if (!registry.has(skill)) {
      return {
        success: false,
        llmContent: `Skill "${skill}" not found. Available skills: ${
          registry
            .getAll()
            .map((s) => s.name)
            .join(', ') || 'none'
        }`,
        displayContent: `❌ Skill "${skill}" not found`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Skill "${skill}" is not registered`,
        },
      };
    }

    // 加载完整的 Skill 内容
    const content = await registry.loadContent(skill);
    if (!content) {
      return {
        success: false,
        llmContent: `Failed to load skill "${skill}" content`,
        displayContent: `❌ Failed to load skill "${skill}"`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: `Could not read SKILL.md for "${skill}"`,
        },
      };
    }

    // 构建完整的 Skill 指令（发送给 LLM）
    const skillInstructions = buildSkillInstructions(
      content.metadata.name,
      content.instructions,
      content.metadata.basePath
    );

    // 返回双消息
    return {
      success: true,
      // llmContent: 完整的 Skill 指令（发送给 LLM，用户不可见）
      llmContent: skillInstructions,
      // displayContent: 可见的加载提示（用户看到）
      displayContent: `<command-message>The "${skill}" skill is loading</command-message>`,
      metadata: {
        skillName: skill,
        basePath: content.metadata.basePath,
        version: content.metadata.version,
        // allowed-tools: 限制 Skill 执行期间可用的工具
        allowedTools: content.metadata.allowedTools,
      },
    };
  },
});

/**
 * 构建完整的 Skill 指令
 */
function buildSkillInstructions(
  name: string,
  instructions: string,
  basePath: string
): string {
  return `# Skill: ${name}

You are now operating in the "${name}" skill mode. Follow the instructions below to complete the task.

**Skill Base Path:** ${basePath}
(You can reference scripts, templates, and references relative to this path)

---

${instructions}

---

Remember: Follow the above instructions carefully to complete the user's request.`;
}
