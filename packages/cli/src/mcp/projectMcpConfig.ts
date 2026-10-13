import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '../config/types.js';
import { Runtime, StringEnum, Type } from '../schema/index.js';
import { normalizeMcpOAuthConfig } from './auth/index.js';
import { normalizeMcpCallLifecycle } from './McpCallLifecycle.js';
import { normalizeMcpRecoveryPolicy } from './McpConnectionRecovery.js';
import { normalizeMcpLoggingPolicy } from './McpLogging.js';
import { normalizeMcpSamplingPolicy } from './McpSampling.js';
import { normalizeMcpTaskPolicy } from './McpTasks.js';

export const MAX_PROJECT_MCP_CONFIG_BYTES = 1024 * 1024;

const Text = Type.String({ pattern: '^[^\\u0000]*$' });
const StringMap = Type.Record(Type.String(), Text);
const ServerSchema = Runtime(
  Type.Object({
    type: StringEnum(['stdio', 'sse', 'http']),
    command: Type.Optional(
      Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' })
    ),
    args: Type.Optional(Type.Array(Text)),
    env: Type.Optional(StringMap),
    cwd: Type.Optional(Text),
    url: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(StringMap),
    timeout: Type.Optional(Type.Integer()),
    idleTimeout: Type.Optional(Type.Integer()),
    sampling: Type.Optional(
      Type.Object({
        enabled: Type.Boolean(),
        maxTokens: Type.Optional(Type.Integer()),
        maxRequestsPerToolCall: Type.Optional(Type.Integer()),
        maxInputBytes: Type.Optional(Type.Integer()),
      })
    ),
    logging: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        level: Type.Optional(
          StringEnum([
            'debug',
            'info',
            'notice',
            'warning',
            'error',
            'critical',
            'alert',
            'emergency',
          ])
        ),
      })
    ),
    tasks: Type.Optional(
      Type.Object({
        enabled: Type.Boolean(),
        defaultTtlMs: Type.Optional(Type.Integer()),
        pollIntervalMs: Type.Optional(Type.Integer()),
        maxTasksPerSession: Type.Optional(Type.Integer()),
        maxLifetimeMs: Type.Optional(Type.Integer()),
      })
    ),
    oauth: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        clientId: Type.Optional(Text),
        scopes: Type.Optional(Type.Array(Text)),
        callbackPort: Type.Optional(Type.Integer()),
      })
    ),
    healthCheck: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        interval: Type.Optional(Type.Integer()),
        timeout: Type.Optional(Type.Integer()),
        failureThreshold: Type.Optional(Type.Integer()),
      })
    ),
    recovery: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        maxAttempts: Type.Optional(Type.Integer()),
        initialDelayMs: Type.Optional(Type.Integer()),
        maxDelayMs: Type.Optional(Type.Integer()),
        jitterRatio: Type.Optional(Type.Number()),
        terminalErrorThreshold: Type.Optional(Type.Integer()),
      })
    ),
  })
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeProjectMcpConfig(
  value: unknown
): Record<string, McpServerConfig> {
  if (!isRecord(value) || !isRecord(value.mcpServers)) {
    throw new Error('.mcp.json must contain an mcpServers object');
  }
  const servers: Record<string, McpServerConfig> = Object.create(null);
  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!name.trim() || !isRecord(raw)) {
      throw new Error('Invalid server entry in .mcp.json');
    }
    const type = raw.type ?? (typeof raw.command === 'string' ? 'stdio' : 'http');
    const parsed = ServerSchema.safeParse({ ...raw, type });
    if (!parsed.success) throw new Error('Invalid server fields in .mcp.json');
    const server = parsed.data;
    if (
      (server.type === 'stdio' && !server.command?.trim()) ||
      (server.type !== 'stdio' && !server.url?.trim())
    ) {
      throw new Error('MCP stdio requires command; http/sse requires url');
    }
    normalizeMcpCallLifecycle(server);
    normalizeMcpLoggingPolicy(server);
    normalizeMcpRecoveryPolicy(server);
    normalizeMcpOAuthConfig(server);
    normalizeMcpTaskPolicy(server.tasks);
    if (server.sampling) normalizeMcpSamplingPolicy(server.sampling);
    servers[name] = server;
  }
  return servers;
}

export async function loadProjectMcpConfig(
  projectRoot: string
): Promise<Record<string, McpServerConfig>> {
  const filePath = path.join(projectRoot, '.mcp.json');
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_PROJECT_MCP_CONFIG_BYTES) {
      throw new Error('.mcp.json exceeds the 1 MiB limit or is not a file');
    }
    const content = await readFile(filePath, 'utf8');
    if (Buffer.byteLength(content) > MAX_PROJECT_MCP_CONFIG_BYTES) {
      throw new Error('.mcp.json exceeds the 1 MiB limit');
    }
    return normalizeProjectMcpConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw new Error('Invalid .mcp.json configuration');
  }
}
