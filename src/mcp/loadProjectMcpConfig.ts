/**
 * .mcp.json 项目配置加载器
 * 在 Agent 启动时自动加载项目级 MCP 配置
 * 支持从 CLI 参数 --mcp-config 和 --strict-mcp-config 加载配置
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager.js';
import type { McpServerConfig } from '../config/types.js';

/**
 * 加载选项
 */
export interface LoadMcpConfigOptions {
  /** 是否启用交互式确认（默认 true） */
  interactive?: boolean;
  /** 是否静默模式（默认 false） */
  silent?: boolean;
  /** CLI 参数：MCP 配置文件路径或 JSON 字符串数组 */
  mcpConfig?: string[];
  /** CLI 参数：严格模式，仅使用 --mcp-config 指定的配置 */
  strictMcpConfig?: boolean;
}

/**
 * 加载 MCP 配置
 *
 * 工作流程：
 * 1. 如果提供了 --mcp-config 参数，优先加载这些配置
 * 2. 如果没有设置 --strict-mcp-config，继续加载项目级 .mcp.json
 * 3. 对于每个服务器：
 *    - 如果已批准（enabledMcpjsonServers），直接加载
 *    - 如果已拒绝（disabledMcpjsonServers），跳过
 *    - 如果未确认，询问用户是否启用
 * 4. 保存用户的确认记录
 *
 * @param options 加载选项
 * @returns 加载的服务器数量
 */
export async function loadProjectMcpConfig(
  options: LoadMcpConfigOptions = {}
): Promise<number> {
  const {
    interactive = true,
    silent = false,
    mcpConfig,
    strictMcpConfig = false,
  } = options;

  let totalLoaded = 0;

  // 1. 优先处理 CLI 参数 --mcp-config
  if (mcpConfig && mcpConfig.length > 0) {
    if (!silent) {
      console.log(`📦 加载来自 --mcp-config 的配置 (${mcpConfig.length} 个源)`);
    }

    for (const configSource of mcpConfig) {
      const loaded = await loadMcpConfigFromSource(configSource, {
        interactive,
        silent,
        sourceType: 'cli-param',
      });
      totalLoaded += loaded;
    }

    if (!silent && totalLoaded > 0) {
      console.log(`✅ 从 --mcp-config 加载了 ${totalLoaded} 个服务器`);
    }
  }

  // 2. 如果设置了 --strict-mcp-config，跳过项目级 .mcp.json
  if (strictMcpConfig) {
    if (!silent) {
      console.log('🔒 严格模式已启用，跳过项目级 .mcp.json');
    }
    return totalLoaded;
  }

  // 3. 加载项目级 .mcp.json（如果存在）
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  // 检查文件是否存在
  try {
    await fs.access(mcpJsonPath);
  } catch {
    // 文件不存在，返回已加载的数量
    return totalLoaded;
  }

  try {
    // 读取并解析配置文件
    const content = await fs.readFile(mcpJsonPath, 'utf-8');
    const mcpJsonConfig = JSON.parse(content);

    if (!mcpJsonConfig.mcpServers || typeof mcpJsonConfig.mcpServers !== 'object') {
      if (!silent) {
        console.warn('⚠️  .mcp.json 格式不正确：缺少 mcpServers 字段');
      }
      return totalLoaded;
    }

    const configManager = ConfigManager.getInstance();
    const projectConfig = await configManager.getProjectConfig();

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

    totalLoaded += loadedCount;
    return totalLoaded;
  } catch (error) {
    if (!silent) {
      console.error(`❌ 加载 .mcp.json 失败:`, error);
    }
    return totalLoaded;
  }
}

/**
 * 从单个配置源加载 MCP 配置
 *
 * @param configSource 配置源（文件路径或 JSON 字符串）
 * @param options 加载选项
 * @returns 加载的服务器数量
 */
async function loadMcpConfigFromSource(
  configSource: string,
  options: {
    interactive: boolean;
    silent: boolean;
    sourceType: 'cli-param' | 'project-file';
  }
): Promise<number> {
  const { interactive, silent, sourceType } = options;

  try {
    let mcpServers: Record<string, McpServerConfig>;

    // 尝试解析为 JSON 字符串
    if (configSource.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(configSource);
        mcpServers = parsed.mcpServers || parsed;
      } catch (jsonError) {
        if (!silent) {
          console.error(`❌ 解析 JSON 字符串失败: ${configSource.slice(0, 50)}...`);
        }
        return 0;
      }
    } else {
      // 作为文件路径处理
      const filePath = path.isAbsolute(configSource)
        ? configSource
        : path.join(process.cwd(), configSource);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        mcpServers = parsed.mcpServers || parsed;
      } catch (fileError) {
        if (!silent) {
          console.error(`❌ 加载配置文件失败: ${filePath}`);
          console.error(`   错误: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
        }
        return 0;
      }
    }

    // 验证配置格式
    if (!mcpServers || typeof mcpServers !== 'object') {
      if (!silent) {
        console.warn(`⚠️  配置格式不正确：缺少 mcpServers 对象`);
      }
      return 0;
    }

    // 加载所有服务器
    const configManager = ConfigManager.getInstance();
    let loadedCount = 0;

    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      try {
        // CLI 参数来源的配置直接加载，不需要用户确认
        if (sourceType === 'cli-param') {
          await configManager.addMcpServer(serverName, serverConfig);
          loadedCount++;
          if (!silent) {
            console.log(`  ✅ ${serverName}`);
          }
        } else {
          // 项目文件需要确认（保留原有逻辑）
          const approved = interactive
            ? await promptUserConfirmation(serverName, serverConfig)
            : false;

          if (approved) {
            await configManager.addMcpServer(serverName, serverConfig);
            loadedCount++;
            if (!silent) {
              console.log(`  ✅ ${serverName}`);
            }
          }
        }
      } catch (error) {
        if (!silent) {
          console.error(`  ❌ 加载服务器 ${serverName} 失败:`, error);
        }
      }
    }

    return loadedCount;
  } catch (error) {
    if (!silent) {
      console.error(`❌ 加载配置源失败:`, error);
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
