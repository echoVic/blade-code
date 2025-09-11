import { DeclarativeTool } from '../tools/base/DeclarativeTool.js';
import { ToolKind, type ToolInvocation } from '../tools/types/index.js';
import { McpClient } from './McpClient.js';
import { McpToolInvocation } from './McpToolInvocation.js';
import type { McpToolDefinition } from './types.js';

/**
 * MCP工具适配器
 * 将MCP工具转换为Blade声明式工具
 */
export class McpToolAdapter extends DeclarativeTool {
  constructor(
    private mcpClient: McpClient,
    private mcpTool: McpToolDefinition
  ) {
    super(
      mcpTool.name,
      `MCP工具: ${mcpTool.name}`,
      mcpTool.description,
      ToolKind.External,
      mcpTool.inputSchema,
      true, // MCP工具默认需要确认
      '1.0.0',
      'MCP工具',
      ['mcp', 'external', mcpTool.name.toLowerCase()]
    );
  }

  build(params: any): ToolInvocation {
    return new McpToolInvocation(this.mcpClient, this.mcpTool, params);
  }

  /**
   * 获取MCP服务器信息
   */
  getServerInfo() {
    return this.mcpClient.server;
  }

  /**
   * 检查工具是否可用（客户端已连接）
   */
  isAvailable(): boolean {
    return this.mcpClient.connectionStatus === 'connected';
  }

  /**
   * 获取工具的完整标识符（包含服务器名称）
   */
  getFullIdentifier(): string {
    const serverInfo = this.mcpClient.server;
    const serverName = serverInfo?.name || 'unknown';
    return `${serverName}.${this.name}`;
  }

  /**
   * 生成工具的元数据
   */
  getMetadata() {
    return {
      ...super.getMetadata(),
      type: 'mcp-tool',
      serverInfo: this.mcpClient.server,
      mcpTool: {
        name: this.mcpTool.name,
        description: this.mcpTool.description,
        inputSchema: this.mcpTool.inputSchema
      }
    };
  }
}