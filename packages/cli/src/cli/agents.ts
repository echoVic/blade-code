import { z } from 'zod';
import type { SubagentConfig } from '../agent/subagents/types.js';
import { mapClaudeCodePermissionMode } from '../agent/subagents/types.js';
import { MAX_AGENT_TURNS } from '../config/maxTurns.js';

const AgentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const ToolListSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(128)
  .transform((tools) => [...new Set(tools)]);

const CliAgentDefinitionSchema = z
  .object({
    description: z.string().trim().min(1).max(4096),
    prompt: z.string().trim().min(1).max(100_000),
    tools: ToolListSchema.optional(),
    disallowedTools: ToolListSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    permissionMode: z
      .enum([
        'default',
        'acceptEdits',
        'dontAsk',
        'bypassPermissions',
        'plan',
        'ignore',
      ])
      .optional(),
    maxTurns: z.number().int().positive().max(MAX_AGENT_TURNS).optional(),
    isolation: z.enum(['none', 'worktree']).optional(),
  })
  .strict();

/** Parse invocation-scoped agent definitions using the Claude Code JSON shape. */
export function parseCliAgents(input: string): SubagentConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON provided to --agents');
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('--agents must be a JSON object');
  }

  const entries = Object.entries(parsed);
  if (entries.length > 64) {
    throw new Error('--agents supports at most 64 definitions');
  }

  return entries.map(([name, definition]) => {
    if (!AgentNameSchema.safeParse(name).success) {
      throw new Error(
        `Invalid --agents name "${name}": use letters, numbers, hyphens, or underscores`
      );
    }

    const result = CliAgentDefinitionSchema.safeParse(definition);
    if (!result.success) {
      throw new Error(`Invalid --agents definition for "${name}"`);
    }

    const value = result.data;
    return {
      name,
      description: value.description,
      systemPrompt: value.prompt,
      tools: value.tools,
      disallowedTools: value.disallowedTools,
      model: value.model,
      permissionMode:
        value.permissionMode === undefined
          ? undefined
          : mapClaudeCodePermissionMode(value.permissionMode),
      maxTurns: value.maxTurns,
      isolation: value.isolation,
      source: 'flag',
    };
  });
}
