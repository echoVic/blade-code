import type { SubagentConfig } from '../agent/subagents/types.js';
import { mapClaudeCodePermissionMode } from '../agent/subagents/types.js';
import { MAX_AGENT_TURNS } from '../config/maxTurns.js';
import { StringEnum, safeParseSchema, Type } from '../schema/index.js';

const AgentNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
});

const ToolListSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' }),
  { maxItems: 128 }
);

const CliAgentDefinitionSchema = Type.Object(
  {
    description: Type.String({
      minLength: 1,
      maxLength: 4096,
      pattern: '.*\\S.*',
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 100_000,
      pattern: '.*\\S.*',
    }),
    tools: Type.Optional(ToolListSchema),
    disallowedTools: Type.Optional(ToolListSchema),
    model: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: '.*\\S.*' })
    ),
    permissionMode: Type.Optional(
      StringEnum([
        'default',
        'acceptEdits',
        'dontAsk',
        'bypassPermissions',
        'plan',
        'ignore',
      ])
    ),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENT_TURNS })),
    isolation: Type.Optional(StringEnum(['none', 'worktree'])),
  },
  { additionalProperties: false }
);

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
    if (!safeParseSchema(AgentNameSchema, name).success) {
      throw new Error(
        `Invalid --agents name "${name}": use letters, numbers, hyphens, or underscores`
      );
    }

    const result = safeParseSchema(CliAgentDefinitionSchema, definition);
    if (!result.success) {
      throw new Error(`Invalid --agents definition for "${name}"`);
    }

    const value = result.data;
    return {
      name,
      description: value.description.trim(),
      systemPrompt: value.prompt.trim(),
      tools: value.tools
        ? [...new Set(value.tools.map((tool) => tool.trim()))]
        : undefined,
      disallowedTools: value.disallowedTools
        ? [...new Set(value.disallowedTools.map((tool) => tool.trim()))]
        : undefined,
      model: value.model?.trim(),
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
