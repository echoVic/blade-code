import { createHash } from 'node:crypto';
import type { JSONSchema7 } from 'json-schema';
import type { McpToolDefinition } from './types.js';

export const MAX_MCP_TOOLS_PER_SERVER = 1_000;
export const MAX_MCP_TOOL_PAGES = 100;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_TOOL_DESCRIPTION_BYTES = 16_384;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_SEGMENT_CHARS = 24;

export interface McpToolCatalogDelta {
  added: string[];
  removed: string[];
  updated: string[];
}

function digest(value: string, length = 10): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}

function providerSegment(value: string): string {
  const normalized = value.normalize('NFKC');
  const safe = normalized.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe && safe === normalized && safe.length <= MAX_PROVIDER_SEGMENT_CHARS) {
    return safe;
  }
  const prefix = (safe || 'unnamed').slice(0, MAX_PROVIDER_SEGMENT_CHARS - 11);
  return `${prefix}_${digest(normalized)}`;
}

export function createMcpProviderToolName(
  serverName: string,
  toolName: string
): string {
  return `${createMcpProviderServerPrefix(serverName)}${providerSegment(toolName)}`;
}

export function createMcpProviderServerPrefix(serverName: string): string {
  return `mcp__${providerSegment(serverName)}__`;
}

export function mcpToolDefinitionSignature(tool: McpToolDefinition): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          taskSupport: tool.taskSupport,
        })
      )
    )
    .digest('hex');
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function normalizeMcpToolCatalog(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    execution?: {
      taskSupport?: 'required' | 'optional' | 'forbidden';
    };
  }>
): McpToolDefinition[] {
  if (tools.length > MAX_MCP_TOOLS_PER_SERVER) {
    throw new Error(`MCP tool catalog exceeds ${MAX_MCP_TOOLS_PER_SERVER} tools`);
  }

  const names = new Set<string>();
  const normalized: McpToolDefinition[] = [];
  let totalBytes = 0;
  for (const tool of tools) {
    const name = tool.name.trim();
    if (!name || name.length > MAX_TOOL_NAME_CHARS || containsControlCharacters(name)) {
      throw new Error('MCP tool catalog contains an invalid tool name');
    }
    if (names.has(name)) {
      throw new Error(`MCP tool catalog contains duplicate tool "${name}"`);
    }
    names.add(name);

    const description = tool.description ?? '';
    if (Buffer.byteLength(description) > MAX_TOOL_DESCRIPTION_BYTES) {
      throw new Error(
        `MCP tool "${name}" description exceeds ${MAX_TOOL_DESCRIPTION_BYTES} bytes`
      );
    }
    const schemaText = JSON.stringify(tool.inputSchema);
    const schemaBytes = Buffer.byteLength(schemaText);
    if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
      throw new Error(
        `MCP tool "${name}" schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`
      );
    }
    totalBytes +=
      Buffer.byteLength(name) + Buffer.byteLength(description) + schemaBytes;
    if (totalBytes > MAX_CATALOG_BYTES) {
      throw new Error(`MCP tool catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
    }

    normalized.push({
      name,
      description,
      inputSchema: JSON.parse(schemaText) as JSONSchema7,
      ...(tool.execution?.taskSupport
        ? { taskSupport: tool.execution.taskSupport }
        : {}),
    });
  }
  return normalized;
}

export function diffMcpToolCatalog(
  previous: readonly McpToolDefinition[],
  next: readonly McpToolDefinition[]
): McpToolCatalogDelta {
  const before = new Map(
    previous.map((tool) => [tool.name, mcpToolDefinitionSignature(tool)])
  );
  const after = new Map(
    next.map((tool) => [tool.name, mcpToolDefinitionSignature(tool)])
  );
  return {
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
    updated: [...after.keys()]
      .filter((name) => before.has(name) && before.get(name) !== after.get(name))
      .sort(),
  };
}

export function hasMcpCatalogChanges(delta: McpToolCatalogDelta): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 || delta.updated.length > 0;
}
