/**
 * .mcp.json 项目配置加载器
 * 在 Agent 启动时自动加载项目级 MCP 配置
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager.js';
import type { McpServerConfig } from '../config/types.js';

/**
 * 加载项目级 .mcp.json 配置
 *
 * 工作流程：
 * 1. 检查当前目录是否存在 .mcp.json
 * 2. 读取并解析配置文件
 * 3. 对于每个服务器：
 *    - 如果已批准（enabledMcpjsonServers），直接加载
 *    - 如果已拒绝（disabledMcpjsonServers），跳过
 *    - 如果未确认，询问用户是否启用
 * 4. 保存用户的确认记录
 *
 * @param options 加载选项
 * @param options.interactive 是否启用交互式确认（默认 true）
 * @param options.silent 是否静默模式（默认 false）
 * @returns 加载的服务器数量
 */
export async function loadProjectMcpConfig(
  options: { interactive?: boolean; silent?: boolean } = {}
): Promise<number> {
  const { interactive = true, silent = false } = options;

  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  // 检查文件是否存在
  try {
    await fs.access(mcpJsonPath);
  } catch {
    // 文件不存在，正常返回
    return 0;
  }

  try {
    // 读取并解析配置文件
    const content = await fs.readFile(mcpJsonPath, 'utf-8');
    const mcpJsonConfig = JSON.parse(content);

    if (!mcpJsonConfig.mcpServers || typeof mcpJsonConfig.mcpServers !== 'object') {
      if (!silent) {
        console.warn('⚠️  .mcp.json 格式不正确：缺少 mcpServers 字段');
      }
      return 0;
    }

    const configManager = ConfigManager.getInstance();
    const projectConfig = await configManager.getProjectConfigAsync();

    const enabledServers = projectConfig.enabledMcpjsonServers || [];
    const disabledServers = projectConfig.disabledMcpjsonServers || [];

    let loadedCount = 0;
    const serversToEnable: string[] = [...enabledServers];

    for (const [serverName, serverConfig] of Object.entries(mcpJsonConfig.mcpServers)) {
      // 已拒绝的跳过
      if (disabledServers.includes(serverName)) {
        if (!silent) {
          console.log(`⏭️  跳过已拒绝的服务器: ${serverName}`);
        }
        continue;
      }

      // 已批准的直接加载
      if (enabledServers.includes(serverName)) {
        await configManager.addMcpServer(serverName, serverConfig as McpServerConfig);
        loadedCount++;
        if (!silent) {
          console.log(`✅ 加载服务器: ${serverName}`);
        }
        continue;
      }

      // 未确认的服务器
      if (!interactive) {
        // 非交互模式：跳过未确认的服务器
        if (!silent) {
          console.log(`⏭️  跳过未确认的服务器: ${serverName} (非交互模式)`);
        }
        continue;
      }

      // 交互式确认
      const approved = await promptUserConfirmation(
        serverName,
        serverConfig as McpServerConfig
      );

      if (approved) {
        await configManager.addMcpServer(serverName, serverConfig as McpServerConfig);
        serversToEnable.push(serverName);
        loadedCount++;
        if (!silent) {
          console.log(`✅ 已启用服务器: ${serverName}`);
        }
      } else {
        disabledServers.push(serverName);
        if (!silent) {
          console.log(`❌ 已拒绝服务器: ${serverName}`);
        }
      }
    }

    // 保存确认记录
    if (interactive) {
      await configManager.updateProjectConfig({
        enabledMcpjsonServers: serversToEnable,
        disabledMcpjsonServers: disabledServers,
      });
    }

    return loadedCount;
  } catch (error) {
    if (!silent) {
      console.error(`❌ 加载 .mcp.json 失败:`, error);
    }
    return 0;
  }
}

/**
 * 询问用户是否启用服务器
 *
 * @param serverName 服务器名称
 * @param config 服务器配置
 * @returns 用户是否同意启用
 */
async function promptUserConfirmation(
  serverName: string,
  config: McpServerConfig
): Promise<boolean> {
  // 动态导入 inquirer 以避免在非交互环境中加载
  try {
    const { default: inquirer } = await import('inquirer');

    console.log(`\n📦 发现新的 MCP 服务器: ${serverName}`);
    console.log(`   类型: ${config.type}`);

    if (config.type === 'stdio') {
      console.log(`   命令: ${config.command} ${config.args?.join(' ') || ''}`);
    } else {
      console.log(`   URL: ${config.url}`);
    }

    const { approve } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'approve',
        message: `是否启用此服务器？`,
        default: false,
      },
    ]);

    return approve;
  } catch (_error) {
    // 如果 inquirer 不可用或出错，默认拒绝
    console.error(`⚠️  无法启动交互式确认，默认拒绝服务器: ${serverName}`);
    return false;
  }
}

/**
 * 检查 .mcp.json 是否存在
 *
 * @returns 是否存在 .mcp.json 文件
 */
export async function hasMcpJson(): Promise<boolean> {
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  try {
    await fs.access(mcpJsonPath);
    return true;
  } catch {
    return false;
  }
}
