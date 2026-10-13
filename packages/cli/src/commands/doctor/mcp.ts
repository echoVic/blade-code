import path from 'node:path';
import type { McpServerConfig } from '../../config/types.js';
import { McpClient } from '../../mcp/McpClient.js';
import { sanitizeMcpConnectionError } from '../../mcp/McpConnectionRecovery.js';
import type { McpToolDefinition } from '../../mcp/types.js';
import type { DoctorDiagnostic } from './diagnostics.js';

const MAX_DECLARATION_BYTES = 25 * 1024;
const CONNECTION_TIMEOUT_MS = 10_000;

export function diagnoseMcpTools(
  name: string,
  tools: readonly McpToolDefinition[]
): DoctorDiagnostic {
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return {
    level: bytes > MAX_DECLARATION_BYTES ? 'warn' : 'ok',
    name: `MCP ${name}`,
    message: `${tools.length} tools; ${bytes} declaration bytes.${
      bytes > MAX_DECLARATION_BYTES
        ? ' Large declarations consume model context when activated; use ToolSearch to load only needed tools.'
        : ''
    }`,
  };
}

async function probeServer(
  name: string,
  config: McpServerConfig,
  cwd: string
): Promise<DoctorDiagnostic> {
  const client = new McpClient(
    {
      ...config,
      cwd: config.cwd ? path.resolve(cwd, config.cwd) : cwd,
      recovery: { enabled: false },
      healthCheck: { enabled: false },
    },
    name
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connectWithRetry(1, 0),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('MCP diagnostic connection timed out after 10 seconds'));
        }, CONNECTION_TIMEOUT_MS);
      }),
    ]);
    return diagnoseMcpTools(name, client.availableTools);
  } catch (error) {
    return {
      level: 'warn',
      name: `MCP ${name}`,
      message: sanitizeMcpConnectionError(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.disconnect();
  }
}

export async function checkDoctorMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
  cwd: string
): Promise<DoctorDiagnostic[]> {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return [{ level: 'ok', name: 'MCP', message: 'No servers configured.' }];
  }
  const results: DoctorDiagnostic[] = new Array(entries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++;
      const [name, config] = entries[index];
      try {
        results[index] = await probeServer(name, config, cwd);
      } catch {
        results[index] = {
          level: 'warn',
          name: `MCP ${name}`,
          message: 'Could not complete the server diagnostic.',
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
