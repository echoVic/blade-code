/**
 * MCP 配置加载器
 *
 * 职责：
 * - 从 CLI --mcp-config 参数加载 MCP 配置
 * - 支持 JSON 文件路径或 JSON 字符串
 * - 将配置临时注入到 Store（不持久化）
 */

import fs from 'fs/promises';
import path from 'path';
import type { McpServerConfig } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { getMcpServers, getState } from '../store/vanilla.js';

const logger = createLogger(LogCategory.GENERAL);

/**
 * 从 CLI --mcp-config 参数加载 MCP 配置
 * 支持多种格式：
 * - JSON 文件路径: "./mcp-config.json"
 * - JSON 字符串 (单个服务器): '{"name": "xxx", "type": "stdio", "command": "xxx"}'
 * - JSON 字符串 (多个服务器): '{"server1": {...}, "server2": {...}}'
 *
 * @param mcpConfigs - CLI 参数数组
 */
export async function loadMcpConfigFromCli(mcpConfigs: string[]): Promise<void> {
  for (const configArg of mcpConfigs) {
    try {
      let configData: Record<string, McpServerConfig>;

      // 尝试解析为 JSON 字符串
      if (configArg.trim().startsWith('{')) {
        const parsed = JSON.parse(configArg);
        // 单个服务器配置: {"name": "xxx", "type": "stdio", ...}
        if (parsed.name && parsed.type) {
          const { name, ...serverConfig } = parsed;
          configData = { [name]: serverConfig as McpServerConfig };
        } else {
          // 多个服务器配置: {"server1": {...}, "server2": {...}}
          configData = parsed;
        }
      } else {
        // 作为文件路径处理
        const filePath = path.resolve(process.cwd(), configArg);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);

        // 支持 {"mcpServers": {...}} 或直接 {"server1": {...}}
        configData = parsed.mcpServers || parsed;
      }

      // 添加到 Store（临时，不持久化）
      const currentServers = getMcpServers();
      const updatedServers = { ...currentServers, ...configData };
      getState().config.actions.updateConfig({ mcpServers: updatedServers });

      logger.debug(
        `✅ Loaded MCP config from CLI: ${Object.keys(configData).join(', ')}`
      );
    } catch (error) {
      logger.warn(`⚠️ Failed to load MCP config "${configArg}":`, error);
    }
  }
}
