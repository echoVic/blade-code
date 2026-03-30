import type { FunctionDeclaration } from '../tools/types/index.js';

export interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export interface AgentSkillContextController {
  activateSkillContext(metadata: Record<string, unknown>): void;
  applyToolRestrictions(tools: FunctionDeclaration[]): FunctionDeclaration[];
  clearSkillContext(): void;
}

export function createAgentSkillContextController({
  debug,
}: {
  debug(message: string): void;
}): AgentSkillContextController {
  let activeSkillContext: SkillExecutionContext | undefined;

  return {
    activateSkillContext(metadata: Record<string, unknown>): void {
      if (!metadata.skillName) {
        return;
      }

      activeSkillContext = {
        skillName: metadata.skillName as string,
        allowedTools: metadata.allowedTools as string[] | undefined,
        basePath: (metadata.basePath as string) || '',
      };

      debug(
        `🎯 Skill "${activeSkillContext.skillName}" activated` +
          (activeSkillContext.allowedTools
            ? ` with allowed tools: ${activeSkillContext.allowedTools.join(', ')}`
            : '')
      );
    },

    applyToolRestrictions(tools: FunctionDeclaration[]): FunctionDeclaration[] {
      if (!activeSkillContext?.allowedTools) {
        return tools;
      }

      const allowedTools = activeSkillContext.allowedTools;
      debug(`🔒 Applying Skill tool restrictions: ${allowedTools.join(', ')}`);

      const filteredTools = tools.filter((tool) =>
        allowedTools.some((allowed) => {
          if (allowed === tool.name) {
            return true;
          }

          const match = allowed.match(/^(\w+)\(.*\)$/);
          if (match && match[1] === tool.name) {
            return true;
          }

          return false;
        })
      );

      debug(
        `🔒 Filtered tools: ${filteredTools.map((tool) => tool.name).join(', ')} (${filteredTools.length}/${tools.length})`
      );

      return filteredTools;
    },

    clearSkillContext(): void {
      if (!activeSkillContext) {
        return;
      }

      debug(`🎯 Skill "${activeSkillContext.skillName}" deactivated`);
      activeSkillContext = undefined;
    },
  };
}
