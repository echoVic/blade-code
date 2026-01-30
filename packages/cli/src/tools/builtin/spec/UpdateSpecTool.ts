/**
 * UpdateSpec Tool
 *
 * 更新 Spec 文件内容（proposal, spec, requirements, design, tasks）
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import type { SpecFileType, SpecPhase } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

const _validFileTypes: SpecFileType[] = [
  'proposal',
  'spec',
  'requirements',
  'design',
  'tasks',
];

/**
 * 根据当前阶段提供下一步指导
 */
function getPhaseGuidance(fileType: string, currentPhase: SpecPhase): string {
  const phaseOrder = ['init', 'requirements', 'design', 'tasks', 'implementation'];
  const fileToPhase: Record<string, string> = {
    proposal: 'init',
    requirements: 'requirements',
    design: 'design',
    tasks: 'tasks',
  };

  const targetPhase = fileToPhase[fileType];
  if (!targetPhase) return '';

  const currentIndex = phaseOrder.indexOf(currentPhase);
  const targetIndex = phaseOrder.indexOf(targetPhase);

  // If updating a file for a later phase, suggest transitioning
  if (targetIndex > currentIndex) {
    return `\n💡 Consider transitioning to "${targetPhase}" phase using TransitionSpecPhase tool.`;
  }

  // Phase-specific guidance
  switch (fileType) {
    case 'proposal':
      return '\n📝 Next: Define requirements in requirements.md using EARS format.';
    case 'requirements':
      return '\n📝 Next: Create technical design in design.md (diagrams, API contracts).';
    case 'design':
      return '\n📝 Next: Break down into tasks in tasks.md (atomic, with dependencies).';
    case 'tasks':
      return '\n📝 Next: Start implementation. Update task status as you progress.';
    default:
      return '';
  }
}

export const updateSpecTool = createTool({
  name: 'UpdateSpec',
  displayName: 'Update Spec',
  kind: ToolKind.Write,

  schema: z.object({
    fileType: z
      .enum(['proposal', 'spec', 'requirements', 'design', 'tasks'])
      .describe('The type of spec file to update'),
    content: z.string().min(1).describe('The content to write to the file'),
    append: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, append to existing content instead of replacing'),
  }),

  description: {
    short: 'Update a spec file in the current Spec project',
    long: `Use this tool to update spec files in the current Spec-Driven Development project.

## Available File Types

- **proposal**: Why this change is needed, background, goals
- **spec**: What the feature does at a high level
- **requirements**: Detailed requirements using EARS format
- **design**: Technical architecture, diagrams, API contracts
- **tasks**: Task breakdown with dependencies

## EARS Format for Requirements

Use the EARS (Easy Approach to Requirements Syntax) format:

- **Ubiquitous**: "The system shall [action]"
- **Event-driven**: "When [trigger], the system shall [action]"
- **Unwanted behavior**: "If [condition], then the system shall [action]"
- **State-driven**: "While [state], the system shall [action]"

## Example Usage

\`\`\`
UpdateSpec({
  fileType: "requirements",
  content: "# Requirements\\n\\n## Functional\\n\\n1. The system shall authenticate users via OAuth2.\\n..."
})
\`\`\`

## Notes

- You must be in Spec mode (have an active spec) to use this tool
- Content overwrites existing file by default
- Use append: true to add to existing content
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { fileType, content, append } = params;

    // Validate we're in Spec mode
    const specManager = SpecManager.getInstance();
    const currentSpec = specManager.getCurrentSpec();

    if (!currentSpec) {
      return {
        success: false,
        llmContent:
          'No active spec. Use EnterSpecMode to start a new spec project, ' +
          'or use the /spec command to load an existing one.',
        displayContent: '❌ No active spec',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'No active spec project',
        },
      };
    }

    try {
      const fileManager = specManager.getFileManager();

      let finalContent = content;
      if (append) {
        const existing = await fileManager.readSpecFile(currentSpec.name, fileType);
        finalContent = existing ? `${existing}\n\n${content}` : content;
      }

      await fileManager.writeSpecFile(currentSpec.name, fileType, finalContent);

      // Calculate content stats
      const lines = finalContent.split('\n').length;
      const chars = finalContent.length;

      return {
        success: true,
        llmContent:
          `✅ Updated ${fileType}.md for "${currentSpec.name}"\n\n` +
          `📊 Stats: ${lines} lines, ${chars} characters\n\n` +
          getPhaseGuidance(fileType, currentSpec.phase),
        displayContent: `✅ Updated ${fileType}.md (${lines} lines)`,
        metadata: {
          featureName: currentSpec.name,
          fileType,
          lines,
          chars,
          append,
        },
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `Failed to update ${fileType}.md: ${error instanceof Error ? error.message : 'Unknown error'}`,
        displayContent: `❌ Failed to update ${fileType}.md`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Write error',
        },
      };
    }
  },
});
