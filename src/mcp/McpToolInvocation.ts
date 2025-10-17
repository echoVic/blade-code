import type {
  ToolErrorType,
  ToolInvocation,
  ToolResult,
} from '../tools/types/index.js';
import { McpClient } from './McpClient.js';
import type { McpToolDefinition } from './types.js';

/**
 * MCP工具调用实现
 */
export class McpToolInvocation implements ToolInvocation {
  readonly toolName: string;
  readonly params: Record<string, any>;

  constructor(
    private mcpClient: McpClient,
    private mcpTool: McpToolDefinition,
    params: Record<string, any>
  ) {
    this.toolName = mcpTool.name;
    this.params = params;
  }

  getDescription(): string {
    const paramsStr =
      Object.keys(this.params).length > 0
        ? ` (${Object.keys(this.params).join(', ')})`
        : '';
    return `调用MCP工具 ${this.toolName}${paramsStr}`;
  }

  getAffectedPaths(): string[] {
    // MCP工具无法预知会影响哪些文件，返回空数组
    return [];
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      if (updateOutput) {
        updateOutput(`正在调用MCP工具 ${this.toolName}...`);
      }

      // 检查连接状态
      if (this.mcpClient.connectionStatus !== 'connected') {
        throw new Error('MCP客户端未连接到服务器');
      }

      // 调用MCP工具
      const response = await this.mcpClient.callTool(this.toolName, this.params);

      if (updateOutput) {
        updateOutput('MCP工具调用完成');
      }

      if (response.isError) {
        return {
          success: false,
          llmContent: `MCP工具 ${this.toolName} 执行失败`,
          displayContent: this.formatErrorContent(response),
          error: {
            message: `MCP工具 ${this.toolName} 执行失败`,
            type: 'EXECUTION_ERROR' as ToolErrorType,
            details: response.content,
          },
        };
      }

      return {
        success: true,
        llmContent: this.formatResponseContent(response),
        displayContent: this.formatDisplayContent(response),
        metadata: {
          toolName: this.toolName,
          serverInfo: this.mcpClient.server,
          contentCount: response.content.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';

      if (updateOutput) {
        updateOutput(`MCP工具调用失败: ${errorMessage}`);
      }

      return {
        success: false,
        llmContent: `MCP工具 ${this.toolName} 调用失败: ${errorMessage}`,
        displayContent: `❌ MCP工具调用失败: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: 'EXECUTION_ERROR' as ToolErrorType,
          details: error,
        },
      };
    }
  }

  /**
   * 格式化响应内容给LLM
   */
  private formatResponseContent(response: any): string {
    const contentItems = response.content || [];
    const textItems = contentItems
      .filter((item: any) => item.type === 'text' && item.text)
      .map((item: any) => item.text)
      .join('\n');

    if (textItems) {
      return `MCP工具 ${this.toolName} 执行结果:\n${textItems}`;
    }

    return `MCP工具 ${this.toolName} 执行完成，返回了 ${contentItems.length} 个内容项`;
  }

  /**
   * 格式化显示内容给用户
   */
  private formatDisplayContent(response: any): string {
    const contentItems = response.content || [];
    let result = `✅ MCP工具 ${this.toolName} 执行成功\n`;

    for (const item of contentItems) {
      switch (item.type) {
        case 'text':
          if (item.text) {
            result += `\n📝 文本内容:\n${item.text}\n`;
          }
          break;
        case 'image':
          result += `\n🖼️  图片内容 (${item.mimeType || '未知格式'})\n`;
          break;
        case 'resource':
          result += `\n📄 资源内容 (${item.mimeType || '未知格式'})\n`;
          break;
        default:
          result += `\n❓ 未知内容类型: ${item.type}\n`;
      }
    }

    return result;
  }

  /**
   * 格式化错误内容
   */
  private formatErrorContent(response: any): string {
    const contentItems = response.content || [];
    let result = `❌ MCP工具 ${this.toolName} 执行失败\n`;

    for (const item of contentItems) {
      if (item.type === 'text' && item.text) {
        result += `\n错误信息: ${item.text}\n`;
      }
    }

    return result;
  }
}
