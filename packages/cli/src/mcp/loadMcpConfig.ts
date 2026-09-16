/**
 * MCP 配置加载器
 *
 * 职责：
 * - 从 CLI --mcp-config 参数加载 MCP 配置
 * - 支持 JSON 文件路径或 JSON 字符串
 * - 提供无副作用解析器，供 SessionRuntime 构造会话级 MCP 配置
 * - 保留 Store 注入兼容入口
 */

import fs from 'fs/promises';
import path from 'path';
import { getOriginalCwd } from '../bootstrap/state.js';
import type { McpServerConfig } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.GENERAL);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMcpConfig(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    throw new Error('MCP configuration must be an object');
  }

  if (typeof value.name === 'string' && typeof value.type === 'string') {
    const { name, ...serverConfig } = value;
    return { [name]: serverConfig as unknown as McpServerConfig };
  }

  const rawServers = isRecord(value.mcpServers) ? value.mcpServers : value;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(rawServers)) {
    if (!name.trim() || !isRecord(rawConfig)) {
      throw new Error(`Invalid MCP server configuration: ${name || '<empty>'}`);
    }
    servers[name] = rawConfig as unknown as McpServerConfig;
  }
  return servers;
}

async function parseMcpConfigArgument(
  configArg: string
): Promise<Record<string, McpServerConfig>> {
  if (configArg.trim().startsWith('{')) {
    return normalizeMcpConfig(JSON.parse(configArg));
  }

  const filePath = path.resolve(getOriginalCwd(), configArg);
  const content = await fs.readFile(filePath, 'utf-8');
  return normalizeMcpConfig(JSON.parse(content));
}

/**
 * Parse CLI MCP sources without mutating process-global configuration.
 * Later arguments override earlier arguments and the supplied base.
 */
export async function resolveMcpConfigFromCli(
  mcpConfigs: readonly string[],
  base: Readonly<Record<string, McpServerConfig>> = {}
): Promise<Record<string, McpServerConfig>> {
  let servers: Record<string, McpServerConfig> = { ...base };
  for (const configArg of mcpConfigs) {
    try {
      const parsed = await parseMcpConfigArgument(configArg);
      servers = { ...servers, ...parsed };
      logger.debug(
        `[OK] Loaded MCP config from CLI: ${Object.keys(parsed).join(', ')}`
      );
    } catch (error) {
      logger.warn(`[WARN] Failed to load MCP config "${configArg}":`, error);
    }
  }
  return servers;
}
