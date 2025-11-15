/**
 * Blade Subagent System - Write Tool Confirmation Handler
 *
 * 处理 Subagent 的写入工具确认逻辑
 *
 * 这是一个适配器，将工具确认请求适配到 Blade 原有的 ConfirmationHandler 接口
 */

import type { ConfirmationHandler } from '../tools/types/index.js';

/**
 * 写入工具列表（需要确认的工具）
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);

/**
 * 只读工具列表（无需确认）
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Ls',
]);

/**
 * 写入工具确认处理器
 *
 * 适配器模式：将工具调用转换为 Blade 的 ConfirmationHandler.requestConfirmation 调用
 *
 * 为 Subagent 提供写入工具确认功能:
 * - 只读工具自动通过
 * - 写入工具代理到父 Agent 的确认处理器
 */
export class WriteToolConfirmationHandler {
  constructor(
    private parentHandler?: ConfirmationHandler,
    private agentName?: string
  ) {}

  /**
   * 检查工具是否需要确认
   *
   * @param toolName 工具名称
   * @param params 工具参数
   * @returns Promise<boolean> 是否批准
   */
  async shouldApprove(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<boolean> {
    // 1. 只读工具自动通过
    if (this.isReadOnlyTool(toolName)) {
      return true;
    }

    // 2. 写入工具需要确认
    if (this.isWriteTool(toolName)) {
      return await this.confirmWriteTool(toolName, params);
    }

    // 3. 未知工具，保守起见需要确认
    return await this.confirmWriteTool(toolName, params);
  }

  /**
   * 检查是否为只读工具
   */
  private isReadOnlyTool(toolName: string): boolean {
    return READ_ONLY_TOOLS.has(toolName);
  }

  /**
   * 检查是否为写入工具
   */
  private isWriteTool(toolName: string): boolean {
    return WRITE_TOOLS.has(toolName);
  }

  /**
   * 确认写入工具调用
   */
  private async confirmWriteTool(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<boolean> {
    // 如果没有父确认处理器，非交互模式自动拒绝
    if (!this.parentHandler) {
      console.warn(
        `[Subagent${this.agentName ? ` ${this.agentName}` : ''}] Attempted to use write tool '${toolName}' in non-interactive mode. Denied.`
      );
      return false;
    }

    // 构造确认消息（适配 Blade 的 ConfirmationDetails 格式）
    const agentInfo = this.agentName ? ` '${this.agentName}'` : '';
    const message = this.formatConfirmationMessage(toolName, params, agentInfo);

    // 代理到父确认处理器（使用 Blade 的 requestConfirmation 接口）
    const response = await this.parentHandler.requestConfirmation({
      type: 'permission',
      title: `Subagent${agentInfo} 请求执行写入操作`,
      message,
      details: this.formatDetails(toolName, params),
    });

    return response.approved;
  }

  /**
   * 格式化详细信息
   */
  private formatDetails(toolName: string, params: Record<string, unknown>): string {
    return `工具: ${toolName}\n参数: ${this.formatParams(params)}`;
  }

  /**
   * 格式化确认消息
   */
  private formatConfirmationMessage(
    toolName: string,
    params: Record<string, unknown>,
    agentInfo: string
  ): string {
    let message = `🤖 Subagent${agentInfo} 想要执行写入操作:\n\n`;
    message += `工具: ${toolName}\n`;

    // 根据不同工具格式化参数显示
    if (toolName === 'Write') {
      message += `文件: ${params.file_path || params.path || '未知'}\n`;
      message += `内容长度: ${params.content?.length || 0} 字符\n`;
    } else if (toolName === 'Edit') {
      message += `文件: ${params.file_path || params.path || '未知'}\n`;
      message += `旧内容: ${this.truncate(params.old_string, 100)}\n`;
      message += `新内容: ${this.truncate(params.new_string, 100)}\n`;
    } else if (toolName === 'Bash') {
      message += `命令: ${this.truncate(params.command, 200)}\n`;
      if (params.run_in_background) {
        message += `后台执行: 是\n`;
      }
    } else if (toolName === 'NotebookEdit') {
      message += `笔记本: ${params.notebook_path || '未知'}\n`;
      message += `单元格: ${params.cell_id || params.cell_number || '未知'}\n`;
    } else {
      // 通用参数显示
      message += `参数: ${this.formatParams(params)}\n`;
    }

    message += `\n是否允许?`;

    return message;
  }

  /**
   * 截断长字符串
   */
  private truncate(str: string | undefined, maxLength: number): string {
    if (!str) return '(空)';
    if (str.length <= maxLength) return str;
    return `${str.slice(0, maxLength)}... (共 ${str.length} 字符)`;
  }

  /**
   * 格式化参数对象
   */
  private formatParams(params: Record<string, unknown>): string {
    try {
      const formatted = JSON.stringify(params, null, 2);
      return this.truncate(formatted, 300);
    } catch {
      return String(params);
    }
  }
}

/**
 * 创建写入工具确认处理器
 *
 * @param parentHandler 父 Agent 的确认处理器（Blade 的 ConfirmationHandler）
 * @param agentName Subagent 名称（用于日志）
 * @returns WriteToolConfirmationHandler 实例
 */
export function createConfirmationHandler(
  parentHandler?: ConfirmationHandler,
  agentName?: string
): WriteToolConfirmationHandler {
  return new WriteToolConfirmationHandler(parentHandler, agentName);
}

/**
 * 检查工具是否为只读工具
 *
 * @param toolName 工具名称
 * @returns boolean
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/**
 * 检查工具是否为写入工具
 *
 * @param toolName 工具名称
 * @returns boolean
 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * 获取所有写入工具列表
 */
export function getWriteTools(): string[] {
  return Array.from(WRITE_TOOLS);
}

/**
 * 获取所有只读工具列表
 */
export function getReadOnlyTools(): string[] {
  return Array.from(READ_ONLY_TOOLS);
}
