import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';

export const CACHE_STABLE_ENVIRONMENT_OPTIONS = {
  includeGitSnapshot: false,
  includeDirectoryListing: false,
} as const;

const PLANNING_DIRECTIVE = `

# Task Execution Strategy
When facing complex multi-step tasks:
1. Break the task into concrete, verifiable steps before acting.
2. Execute one step at a time — verify each step succeeded before moving to the next.
3. If a step fails, diagnose the root cause rather than repeating the same approach.
4. When uncertain about file paths or project structure, use Grep/Glob/Read to gather facts first.
5. Prefer the smallest change that achieves the goal — avoid unnecessary refactoring.`;

export function composeProviderSystemPrompt(
  systemPrompt: string | undefined,
  registry: Pick<ToolRegistry, 'getDeferredToolsListing'>
): string | undefined {
  if (!systemPrompt) return systemPrompt;
  const deferredListing = registry.getDeferredToolsListing();
  return `${systemPrompt}${deferredListing ? `\n\n${deferredListing}` : ''}${PLANNING_DIRECTIVE}`;
}
